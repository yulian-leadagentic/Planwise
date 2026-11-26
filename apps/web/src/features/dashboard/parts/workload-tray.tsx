import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { Check, Inbox, RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dayLabel, type DragSource, type OverloadItem } from '../workload-assign';
import type { ReassignmentRequest, TrayOverdueItem, WorkloadTaskEntry, WorkloadTray } from '../workload-contract';
import type { TeamWorkloadPerson } from '../workload-range';
import { chipTitle } from './workload-chip';
import { DraggableChip, type DragData, type DropTarget } from './workload-dnd';

/**
 * QA6 P4 (PR-063): the tray of the Workload tab. It replaces the
 * "Overload Tasks" panel there (D13; the scheduler list stays on Risk &
 * Review and the project workload panel). Three groups to drag from
 * (Unassigned, Overdue, Causing overload), a drop zone that unassigns,
 * and the moves waiting for my approval.
 */

export const TRAY_DROP_ID = 'tray';
const TRAY_TARGET: DropTarget = { kind: 'tray' };
const COLLAPSED_COUNT = 12;

type Props = {
  tray: WorkloadTray | undefined;
  trayLoading: boolean;
  trayError: boolean;
  onRetry: () => void;
  overload: OverloadItem[];
  tasks: Record<string, WorkloadTaskEntry>;
  peopleById: Map<number, TeamWorkloadPerson>;
  canDrag: (task: WorkloadTaskEntry, fromUserId: number | null) => boolean;
  active: DragData | null;
  approvalsCount: number;
  onOpenTask: (taskId: number) => void;
  onApprove: (r: ReassignmentRequest) => void;
  onReject: (r: ReassignmentRequest) => void;
  deciding: number | null;
  focusApprovals?: boolean;
};

const hoursOf = (t: WorkloadTaskEntry) => t.remainingHours ?? t.budgetHours ?? 0;
const shortName = (name: string | null | undefined) => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};
const personName = (p: TeamWorkloadPerson | undefined) => (p ? p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') : '');

export function WorkloadTray(props: Props) {
  const { tray, trayLoading, trayError, onRetry, overload, tasks, peopleById, canDrag, active, approvalsCount, onOpenTask } = props;
  // Only a chip that belongs to someone can be dropped back here (unassign).
  const acceptsDrop = !!active && active.source.fromUserId != null;
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROP_ID, data: { target: TRAY_TARGET }, disabled: !acceptsDrop });
  const approvalsRef = useRef<HTMLDivElement>(null);
  const approvals = tray?.approvals ?? [];

  useEffect(() => {
    if (props.focusApprovals && approvals.length > 0) approvalsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [props.focusApprovals, approvals.length]);

  const sibling = (taskId: number) => active?.task.id === taskId;

  const unassignedChips = (tray?.unassigned.items ?? []).map((t) => {
    const source: DragSource = { taskId: t.id, fromUserId: null, fromDay: null, hours: hoursOf(t), origin: 'unassigned' };
    return (
      <DraggableChip
        key={`u-${t.id}`}
        source={source}
        task={t}
        view={{ code: t.code, name: t.name, hours: hoursOf(t), overdue: t.overdue, logged: t.loggedUserIds.length > 0, pending: !!t.pending }}
        canDrag={canDrag(t, null)}
        sibling={sibling(t.id)}
        title={chipTitle(t)}
        onOpen={() => onOpenTask(t.id)}
      />
    );
  });

  const overdueChips = (tray?.overdue.items ?? []).map((t: TrayOverdueItem) => {
    const source: DragSource = { taskId: t.id, fromUserId: t.assigneeId, fromDay: null, hours: hoursOf(t), origin: 'overdue' };
    return (
      <DraggableChip
        key={`o-${t.id}-${t.assigneeId}`}
        source={source}
        task={t}
        view={{ code: t.code, name: t.name, hours: hoursOf(t), overdue: true, logged: t.loggedUserIds.length > 0, pending: !!t.pending, meta: shortName(t.assigneeName) }}
        canDrag={canDrag(t, t.assigneeId)}
        sibling={sibling(t.id)}
        title={[chipTitle(t, { personId: t.assigneeId }), t.assigneeName ? `Assigned to ${t.assigneeName}` : null, t.endDate ? `Was due ${t.endDate}` : null].filter(Boolean).join('\n')}
        onOpen={() => onOpenTask(t.id)}
      />
    );
  });

  const overloadChips = overload.map((o) => {
    const t = tasks[String(o.taskId)];
    const p = peopleById.get(o.personId);
    const source: DragSource = { taskId: o.taskId, fromUserId: o.personId, fromDay: o.day, hours: o.hours, origin: 'overload' };
    return (
      <DraggableChip
        key={`v-${o.taskId}-${o.personId}`}
        source={source}
        task={t ?? null}
        view={{ code: t?.code ?? null, name: t?.name ?? '', hours: o.hours, logged: (t?.loggedUserIds.length ?? 0) > 0, meta: `${shortName(personName(p))} ${dayLabel(o.day)}` }}
        canDrag={!!t && canDrag(t, o.personId)}
        sibling={sibling(o.taskId)}
        title={[chipTitle(t, { personId: o.personId }), `${personName(p)} is over capacity on ${dayLabel(o.day)}`].filter(Boolean).join('\n')}
        onOpen={() => onOpenTask(o.taskId)}
      />
    );
  });

  const trayBody = (chips: ReactNode[], total: number, empty: string) => {
    if (trayError) {
      return (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:underline">
          <RefreshCw className="h-3 w-3" aria-hidden="true" /> Could not load. Retry
        </button>
      );
    }
    if (trayLoading && !tray) return <span className="text-[11px] text-slate-400 dark:text-slate-500">Loading…</span>;
    return <ChipGroup chips={chips} total={total} empty={empty} />;
  };

  return (
    <section className="overflow-hidden rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900" aria-label="Tasks to place">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 dark:border-slate-800 px-4 py-3">
        <h3 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">Tasks to place</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Drag a chip onto a person&apos;s day to assign it. Drop a chip here to unassign it.
        </p>
        {approvalsCount > 0 && (
          <span className="ml-auto rounded-[5px] bg-violet-50 dark:bg-violet-500/15 px-2 py-0.5 text-[11px] font-bold tracking-wide text-violet-700 dark:text-violet-300">
            <span className="font-mono">{approvalsCount}</span> waiting for my approval
          </span>
        )}
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          'relative grid gap-4 p-4 md:grid-cols-3 transition-colors duration-150',
          acceptsDrop && (isOver ? 'bg-blue-50 dark:bg-blue-500/10' : 'bg-[#FAFBFC] dark:bg-slate-800/40'),
        )}
        data-testid="workload-tray"
      >
        {acceptsDrop && (
          <div
            className={cn(
              'pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[10px] border-[1.5px] border-dashed text-[12px] font-semibold',
              isOver ? 'border-blue-500 text-blue-700 dark:text-blue-300' : 'border-slate-300 text-slate-500 dark:border-slate-600 dark:text-slate-400',
            )}
          >
            <span className="rounded-lg bg-white/90 dark:bg-slate-900/90 px-3 py-1">Drop here to unassign</span>
          </div>
        )}
        <TrayGroup label="Unassigned" count={tray?.unassigned.total}>
          {trayBody(unassignedChips, tray?.unassigned.total ?? 0, 'None')}
        </TrayGroup>
        <TrayGroup label="Overdue" count={tray?.overdue.total}>
          {trayBody(overdueChips, tray?.overdue.total ?? 0, 'None')}
        </TrayGroup>
        <TrayGroup label="Causing overload (>100% on a day)" count={overload.length}>
          <ChipGroup chips={overloadChips} total={overloadChips.length} empty="All clear" />
        </TrayGroup>
      </div>

      {approvals.length > 0 && (
        <div ref={approvalsRef} className="border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <Inbox className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" />
            <h4 className="text-[13px] font-bold text-slate-900 dark:text-slate-100">Waiting for my approval</h4>
            <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{approvals.length}</span>
          </div>
          <ul className="pb-2">
            {approvals.map((r) => (
              <ApprovalRow key={r.id} r={r} busy={props.deciding === r.id} onApprove={() => props.onApprove(r)} onReject={() => props.onReject(r)} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function TrayGroup({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400 dark:text-slate-500">
        {label}
        {count != null && count > 0 && <span className="font-mono normal-case tracking-normal text-slate-500 dark:text-slate-400">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function ChipGroup({ chips, total, empty }: { chips: ReactNode[]; total: number; empty: string }) {
  const [all, setAll] = useState(false);
  if (chips.length === 0) return <span className="text-[11px] text-slate-400 dark:text-slate-500">{empty}</span>;
  const shown = all ? chips : chips.slice(0, COLLAPSED_COUNT);
  const hidden = chips.length - shown.length;
  const notLoaded = Math.max(0, total - chips.length);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c, i) => (
        <div key={i} className="max-w-[260px] min-w-0">{c}</div>
      ))}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="text-[11px] font-semibold text-blue-600 hover:underline">
          Show <span className="font-mono">{hidden}</span> more
        </button>
      )}
      {all && chips.length > COLLAPSED_COUNT && (
        <button type="button" onClick={() => setAll(false)} className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:underline">
          Show fewer
        </button>
      )}
      {notLoaded > 0 && (
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          and <span className="font-mono">{notLoaded}</span> more not listed
        </span>
      )}
    </div>
  );
}

function ApprovalRow({ r, busy, onApprove, onReject }: { r: ReassignmentRequest; busy: boolean; onApprove: () => void; onReject: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <div className="flex min-w-0 items-center gap-1.5">
        {r.task.code && <span className="shrink-0 font-mono text-xs font-medium text-slate-500 dark:text-slate-400">{r.task.code}</span>}
        <span dir="auto" className="min-w-0 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100 max-w-[260px]">{r.task.name}</span>
        {r.task.projectName && <span dir="auto" className="shrink-0 truncate text-[11px] text-slate-400 dark:text-slate-500 max-w-[160px]">{r.task.projectName}</span>}
        {r.task.hours != null && <span className="shrink-0 font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">{r.task.hours}h</span>}
      </div>
      <div className="min-w-0 text-[12px] text-slate-600 dark:text-slate-300">
        {r.from?.name ?? 'Unassigned'}
        {r.from?.orgUnitName && <span className="text-slate-400 dark:text-slate-500"> ({r.from.orgUnitName})</span>}
        <span className="px-1 text-slate-400 dark:text-slate-500">→</span>
        {r.to?.name ?? 'Unassigned'}
        {r.to?.orgUnitName && <span className="text-slate-400 dark:text-slate-500"> ({r.to.orgUnitName})</span>}
      </div>
      <div className="text-[11px] text-slate-400 dark:text-slate-500">
        {r.toDay && <span className="font-mono">{dayLabel(r.toDay)}</span>}
        {r.requestedBy && <span>{r.toDay ? ' · ' : ''}requested by {r.requestedBy.name}</span>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Approve
        </button>
      </div>
    </li>
  );
}
