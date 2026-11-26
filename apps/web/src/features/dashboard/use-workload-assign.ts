import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import client from '@/api/client';
import { apiErrorCode, apiErrorDetails, notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import {
  applyOptimisticMove,
  applyPeopleRows,
  applyTaskPatch,
  applyTrayMove,
  approveToastText,
  reassignErrorKey,
  reassignErrorText,
  type ReassignErrorContext,
  reassignToastText,
  type DragOrigin,
  type OptimisticMove,
} from './workload-assign';
import {
  normalizeDecisionResponse,
  normalizeReassignResponse,
  type ReassignBody,
  type ReassignDecisionResponse,
  type ReassignmentRequest,
  type ReassignResponse,
  type ReassignView,
  type WorkloadPending,
  type WorkloadTray,
} from './workload-contract';
import type { TeamWorkload } from './workload-range';

/**
 * QA6 P4 (PR-063): the writes of the Workload board.
 *  - `POST /tasks/:id/reassign`: optimistic board + tray, rollback on
 *    error, then the server's rows for the two people, a toast with Undo,
 *    and `['workload']` refetched (team + tray).
 *  - `POST /workload/reassignments/:id/undo | approve | reject` (all 200).
 * Errors are worded by `reassignErrorKey` (a 403 is PERMISSION_DENIED
 * with `details.reason`); every write refetches `['workload']`, so a
 * stale / already-decided answer also refreshes the board and the tray.
 */

export type MoveVars = {
  body: ReassignBody;
  move: OptimisticMove;
  origin: DragOrigin;
  /** Optimistic only: the target would wait for approval (D1 + D3). The server's `result` decides. */
  predictPending: boolean;
  teamKey: QueryKey;
  trayKey: QueryKey;
  names: { taskLabel: string; fromName: string | null; toName: string | null; otherAssigneeNames: string[] };
};

type Snapshot = { team?: TeamWorkload; tray?: WorkloadTray };

const UNDO_TOAST_MS = 12_000;
const unwrap = (r: { data: any }) => r.data?.data ?? r.data;

function showError(err: unknown, fallback: string, context: ReassignErrorContext) {
  const key = reassignErrorKey(apiErrorCode(err), apiErrorDetails(err), context);
  const text = reassignErrorText(key);
  if (text) notify.warning(text.title, { description: text.description, code: key ?? undefined, duration: 8000 });
  else notify.apiError(err, fallback);
}

export function useWorkloadAssign({ view, teamKey }: { view: ReassignView | null; teamKey: QueryKey }) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);

  const applyServer = (key: QueryKey, res: Pick<ReassignDecisionResponse, 'task' | 'people'>, taskId: number, pending: WorkloadPending | null) => {
    const cur = qc.getQueryData<TeamWorkload>(key);
    if (!cur) return;
    qc.setQueryData<TeamWorkload>(key, applyTaskPatch(applyPeopleRows(cur, res.people), res.task, pending, taskId));
  };

  const undo = useMutation({
    mutationFn: ({ id }: { id: number; taskId: number; teamKey: QueryKey }) =>
      client.post(`/workload/reassignments/${id}/undo`, { view: view ?? undefined }).then((r) => normalizeDecisionResponse(unwrap(r))),
    onSuccess: (res, vars) => {
      applyServer(vars.teamKey, res, vars.taskId, null);
      notify.success(res.result === 'cancelled' ? 'Approval request cancelled' : 'Move undone');
    },
    onError: (err) => showError(err, 'Could not undo the move', 'undo'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['workload'] }),
  });

  const move = useMutation<ReassignResponse, unknown, MoveVars, Snapshot>({
    mutationFn: (vars) =>
      client.post(`/tasks/${vars.move.task.id}/reassign`, vars.body).then((r) => normalizeReassignResponse(unwrap(r))),
    onMutate: async (vars) => {
      await Promise.all([qc.cancelQueries({ queryKey: vars.teamKey }), qc.cancelQueries({ queryKey: vars.trayKey })]);
      const team = qc.getQueryData<TeamWorkload>(vars.teamKey);
      const tray = qc.getQueryData<WorkloadTray>(vars.trayKey);
      const pending: WorkloadPending | null = vars.predictPending
        ? {
            id: 0,
            fromUserId: vars.body.fromUserId,
            toUserId: vars.body.toUserId,
            toName: vars.names.toName,
            approver: null,
            requestedBy: me ? { id: me.id, name: `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() } : null,
            createdAt: new Date().toISOString(),
          }
        : null;
      if (team) qc.setQueryData<TeamWorkload>(vars.teamKey, applyOptimisticMove(team, { ...vars.move, pending }));
      if (tray) qc.setQueryData<WorkloadTray>(vars.trayKey, applyTrayMove(tray, { ...vars.move, pending, origin: vars.origin }));
      return { team, tray };
    },
    onError: (err, vars, snap) => {
      if (snap?.team) qc.setQueryData(vars.teamKey, snap.team);
      if (snap?.tray) qc.setQueryData(vars.trayKey, snap.tray);
      showError(err, 'Could not move the task', 'move');
    },
    onSuccess: (res, vars) => {
      const taskId = vars.move.task.id;
      const pending: WorkloadPending | null =
        res.result === 'pending'
          ? {
              id: res.reassignment.id,
              fromUserId: vars.body.fromUserId,
              toUserId: vars.body.toUserId,
              toName: vars.names.toName,
              approver: res.reassignment.approver,
              requestedBy: me ? { id: me.id, name: `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() } : null,
              createdAt: new Date().toISOString(),
            }
          : null;
      applyServer(vars.teamKey, res, taskId, pending);

      const { title, description } = reassignToastText(res, { ...vars.names, toDay: vars.body.toDay });
      const canUndo = res.reassignment.id > 0;
      const action = canUndo
        ? { label: 'Undo', onClick: () => undo.mutate({ id: res.reassignment.id, taskId, teamKey: vars.teamKey }) }
        : undefined;
      const show = res.result === 'pending' ? notify.info : notify.success;
      show(title, { description: description || undefined, action, duration: canUndo ? UNDO_TOAST_MS : undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['workload'] }),
  });

  const decide = useMutation({
    // Approve takes an optional `{ view }` so its `people` rows match the
    // board week; reject takes an optional `{ note }`.
    mutationFn: ({ r, decision }: { r: ReassignmentRequest; decision: 'approve' | 'reject' }) =>
      client
        .post(`/workload/reassignments/${r.id}/${decision}`, decision === 'approve' ? (view ? { view } : {}) : {})
        .then((res) => normalizeDecisionResponse(unwrap(res))),
    onSuccess: (res, { r, decision }) => {
      if (decision === 'approve') {
        applyServer(teamKey, res, r.task.id, null);
        const { title, description } = approveToastText(res, r);
        notify.success(title, { description: description || undefined });
      } else {
        notify.success(`Rejected: ${r.task.code ?? r.task.name} stays with ${r.from?.name ?? 'the current person'}`);
      }
    },
    onError: (err, { decision }) => {
      if (decision === 'approve' && apiErrorCode(err) === 'REASSIGN_STALE') {
        notify.warning('The request could not be applied', {
          description: 'The task changed after the request was made. The requester was told.',
          code: 'REASSIGN_STALE',
          duration: 8000,
        });
        return;
      }
      showError(err, decision === 'approve' ? 'Could not approve the move' : 'Could not reject the move', decision);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['workload'] }),
  });

  return { move, undo, decide };
}
