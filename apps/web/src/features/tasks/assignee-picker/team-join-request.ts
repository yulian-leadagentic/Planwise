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
  /** Fallback when the server refuses because the screen is out of date and sends no message. */
  stale: 'Your access to this project has changed. Reopen the picker.',
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
 * `teamRequestedAt` from GET /projects/:id: his own request of the last
 * 24 hours (ISO), so the button opens as "sent" after a reload. Null
 * when there is none, or from a server that does not send the field.
 */
export function readTeamRequestedAt(project: { teamRequestedAt?: unknown } | null | undefined): string | null {
  const v = project?.teamRequestedAt;
  return typeof v === 'string' && v ? v : null;
}

/**
 * State of the button. A fresh request, `alreadyRequested`, and a
 * request the server reports on the project (`teamRequestedAt`) all end
 * in 'sent' (same text, disabled): the project manager has a request
 * either way.
 */
export type TeamRequestState = 'idle' | 'sending' | 'sent';

export function teamRequestState(args: {
  pending: boolean;
  /** Sent from this screen (the mutation's answer). */
  sentAt: string | null | undefined;
  /** `teamRequestedAt` of GET /projects/:id. */
  serverRequestedAt?: string | null;
}): TeamRequestState {
  if (args.sentAt || args.serverRequestedAt) return 'sent';
  return args.pending ? 'sending' : 'idle';
}

/**
 * A refused request. 409 ALREADY_ON_TEAM / CAN_MANAGE_PROJECT mean the
 * screen is out of date (he is on the Team now, or can add himself):
 * refresh and show the server's message. Anything else is an error.
 */
export function teamRequestFailure(errorCode: string | null): 'stale' | 'error' {
  return errorCode === 'ALREADY_ON_TEAM' || errorCode === 'CAN_MANAGE_PROJECT' ? 'stale' : 'error';
}
