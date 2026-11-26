/**
 * QA6 decision 2 (26.11) — no self-assign for a viewer who is not on the
 * project's Team.
 *
 * An employee who sees a project only through his org unit or manager
 * chain is not on its Team. The server refuses his self-assign (403
 * ASSIGNEE_NOT_ON_TEAM); the web offers "ask the project manager to add
 * you" (POST /projects/:id/team-requests) in its place. Only the leader /
 * an Admin adds outsiders to the Team (package 1).
 *
 * Pure so it is unit-tested (team-join-request.spec.ts) and shared by
 * the task drawer, the planning grid picker and the timesheet quick task.
 */

export const TEAM_REQUEST_TEXT = {
  /** The decision's button label. */
  button: 'בקש ממנהל הפרויקט להוסיף אותך',
  /** After the request was sent, or when one was sent in the last 24 hours. */
  sent: 'הבקשה נשלחה למנהל הפרויקט',
  /** Why the button is there instead of assigning himself. */
  explanation: 'אינך בצוות הפרויקט, ולכן אין באפשרותך לשייך את עצמך למשימה.',
  /** The server says he is on the Team after all (stale screen). */
  alreadyOnTeam: 'You are already on this project team. Reopen the picker to assign yourself.',
} as const;

/**
 * What a picker offers the viewer about assigning HIMSELF:
 *   • 'self'    — he may (personal task, on the Team, or leader / Admin:
 *                 the server adds a manager to the Team as participant);
 *   • 'request' — not on the Team and cannot manage: the request button;
 *   • 'unknown' — the project read has not answered yet: show neither.
 */
export type SelfAssignMode = 'self' | 'request' | 'unknown';

export function selfAssignMode(args: {
  projectId: number | null | undefined;
  /** From GET /projects/:id; undefined while loading. */
  project: { isOnTeam?: boolean | null; canManage?: boolean | null } | null | undefined;
}): SelfAssignMode {
  if (!args.projectId) return 'self';
  const p = args.project;
  if (!p || typeof p.isOnTeam !== 'boolean') return 'unknown';
  if (p.isOnTeam || p.canManage === true) return 'self';
  return 'request';
}

/** The answer of POST /projects/:id/team-requests (envelope or bare). */
export interface TeamJoinRequestResult {
  alreadyRequested: boolean;
  requestedAt: string | null;
}

export function readTeamJoinRequestResult(raw: unknown): TeamJoinRequestResult {
  const body = (raw as { data?: unknown } | null | undefined) ?? null;
  const inner = (body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object'
    ? body.data
    : body) as { alreadyRequested?: unknown; requestedAt?: unknown } | null;
  return {
    alreadyRequested: inner?.alreadyRequested === true,
    requestedAt: typeof inner?.requestedAt === 'string' ? inner.requestedAt : null,
  };
}

/**
 * State of the button. A fresh request and `alreadyRequested` both end
 * in 'sent' (same text, disabled): the project manager has a request
 * either way.
 */
export type TeamRequestState = 'idle' | 'sending' | 'sent';

export function teamRequestState(args: { pending: boolean; sentAt: string | null | undefined }): TeamRequestState {
  if (args.sentAt) return 'sent';
  return args.pending ? 'sending' : 'idle';
}

/** A refused request: 409 ALREADY_ON_TEAM means the screen is stale, anything else is an error to show. */
export function teamRequestFailure(errorCode: string | null): 'already-on-team' | 'error' {
  return errorCode === 'ALREADY_ON_TEAM' ? 'already-on-team' : 'error';
}
