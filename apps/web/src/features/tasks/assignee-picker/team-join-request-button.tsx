import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, UserPlus } from 'lucide-react';

import { projectsApi } from '@/api/projects.api';
import { apiErrorCode, getErrorMessage, notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import {
  readTeamJoinRequestResult,
  TEAM_REQUEST_TEXT,
  teamRequestFailure,
  teamRequestState,
  type TeamRequestState,
} from './team-join-request';

const requestKey = (projectId: number) => ['team-join-request', projectId] as const;

/**
 * QA6 decision 2 — "ask the project manager to add me", shared by every
 * picker row of one project: the sent state lives in the query cache
 * under ['team-join-request', projectId], so once one row (or the drawer)
 * sent it, every button of that project shows "sent" and is disabled.
 */
export function useTeamJoinRequest(
  projectId: number,
  /** `teamRequestedAt` of GET /projects/:id: a request of the last 24 hours opens as "sent". */
  serverRequestedAt?: string | null,
): { state: TeamRequestState; request: () => void } {
  const queryClient = useQueryClient();
  const key = requestKey(projectId);
  // Written by the mutation below, never fetched.
  const { data: sentAt } = useQuery<string | null>({
    queryKey: key,
    queryFn: () => queryClient.getQueryData<string | null>(key) ?? null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const pending = useIsMutating({ mutationKey: key }) > 0;
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: () => projectsApi.requestToJoinTeam(projectId),
    onSuccess: (raw) => {
      // A fresh request and `alreadyRequested` end the same way: sent.
      const res = readTeamJoinRequestResult(raw);
      queryClient.setQueryData(key, res.requestedAt ?? new Date().toISOString());
    },
    onError: (err) => {
      if (teamRequestFailure(apiErrorCode(err)) === 'stale') {
        // He was added meanwhile, or can add himself: refresh what the
        // pickers read and say why (the server's plain message).
        queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
        queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
        notify.info(getErrorMessage(err, TEAM_REQUEST_TEXT.stale));
      } else {
        notify.apiError(err, 'Could not send the request to the project manager');
      }
    },
  });
  const state = teamRequestState({ pending, sentAt, serverRequestedAt });
  return {
    state,
    request: () => {
      if (state === 'idle') mutation.mutate();
    },
  };
}

/**
 * In place of assigning himself: one line on why, then the button. After
 * the request (or when one was sent in the last 24 hours, also across a
 * reload through `requestedAt`) the button reads "הבקשה נשלחה למנהל
 * הפרויקט" and is disabled.
 */
export function TeamJoinRequest({
  projectId,
  requestedAt,
  className,
}: {
  projectId: number;
  /** `teamRequestedAt` of GET /projects/:id (see `useAssigneeScope`). */
  requestedAt?: string | null;
  className?: string;
}) {
  const { state, request } = useTeamJoinRequest(projectId, requestedAt);
  const sent = state === 'sent';
  return (
    <div dir="rtl" className={cn('px-3 py-2 text-right', className)}>
      <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{TEAM_REQUEST_TEXT.explanation}</p>
      <button
        type="button"
        disabled={state !== 'idle'}
        aria-live="polite"
        onClick={(e) => {
          e.stopPropagation();
          request();
        }}
        className={cn(
          'mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-all duration-150',
          sent
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500',
          state === 'sending' && 'opacity-60',
        )}
      >
        {sent ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />}
        {sent ? TEAM_REQUEST_TEXT.sent : TEAM_REQUEST_TEXT.button}
      </button>
    </div>
  );
}
