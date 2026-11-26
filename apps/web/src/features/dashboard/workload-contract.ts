import type { TeamWorkload, TeamWorkloadPerson } from './workload-range';

/**
 * QA6 P4 (PR-063): the wire contract of the Workload drag-and-drop
 * (docs/bm2/qa6-pr063-locked-spec.md › API, research §10.4). The API
 * agent builds the server side in parallel, so every payload goes through
 * one adapter here: a field the server leaves out falls back to the safe
 * value (nothing draggable, no pending, empty lists) instead of crashing
 * the board. Dates are `YYYY-MM-DD`.
 */

export type WorkloadUserRef = { id: number; name: string };

export type WorkloadPending = {
  id: number;
  fromUserId: number | null;
  toUserId: number | null;
  toName: string | null;
  /** null = no department manager: any Admin decides (D2). */
  approver: WorkloadUserRef | null;
  requestedBy: WorkloadUserRef | null;
  createdAt: string | null;
};

/** `GET /workload/team` › `tasks[id]`: a non-masked task on the board (masked tasks never get one). */
export type WorkloadTaskEntry = {
  id: number;
  code: string | null;
  name: string;
  projectId: number | null;
  projectName: string | null;
  /** The effective service (kind = service); null when none or a project phase. */
  service: { id: number; name: string } | null;
  status: string | null;
  estimatedStartDate: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetHours: number | null;
  remainingHours: number | null;
  assigneeIds: number[];
  loggedUserIds: number[];
  /** Only for people the viewer may see, or the project leader; else null. */
  loggedHoursByUser: Record<string, number> | null;
  overdue: boolean;
  /** Project-manage part only (Admin or leader). Final = canDrag || people[from].canDragFrom. */
  canDrag: boolean;
  pending: WorkloadPending | null;
  /** Not in the contract; read when the server sends it (see isPersonalTask). */
  isPersonal?: boolean;
};

export type WorkloadAssign = {
  /** Any chip draggable for this caller. */
  canAssign: boolean;
  projects: Record<string, { canManage: boolean; teamUserIds: number[] }>;
  /** Only services with a requirement. */
  services: Record<string, { requiredQualificationIds: number[] }>;
  approvalsWaitingForMe: number;
};

export type TrayOverdueItem = WorkloadTaskEntry & { assigneeId: number; assigneeName: string | null };

export type ReassignmentRequest = {
  id: number;
  status: string;
  task: { id: number; code: string | null; name: string; projectId: number | null; projectName: string | null; hours: number | null };
  from: { id: number; name: string; orgUnitName: string | null } | null;
  to: { id: number; name: string; orgUnitName: string | null } | null;
  fromDay: string | null;
  toDay: string | null;
  newEstimatedStartDate: string | null;
  newEndDate: string | null;
  requestedBy: WorkloadUserRef | null;
  approver: WorkloadUserRef | null;
  createdAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type WorkloadTray = {
  unassigned: { total: number; items: WorkloadTaskEntry[] };
  overdue: { total: number; items: TrayOverdueItem[] };
  approvals: ReassignmentRequest[];
};

export type ReassignView = { from: string; to: string };

export type ReassignBody = {
  fromUserId: number | null;
  toUserId: number | null;
  fromDay: string | null;
  toDay: string | null;
  view: ReassignView;
};

export type ReassignTaskPatch = {
  id: number;
  assigneeIds: number[];
  estimatedStartDate: string | null;
  endDate: string | null;
  dueDateOverridden: boolean;
};

export type ReassignWarning = { code: string; taskId: number | null; message: string };

export type ReassignResponse = {
  result: 'applied' | 'pending';
  reassignment: {
    id: number;
    status: string;
    crossDepartment: boolean;
    approver: WorkloadUserRef | null;
    undoUntil: string | null;
  };
  task: ReassignTaskPatch | null;
  changed: { assignee: boolean; dates: boolean };
  addedToTeam: boolean;
  loggedStays: { userId: number; name: string; hours: number | null } | null;
  warnings: ReassignWarning[];
  people: TeamWorkloadPerson[];
};

/** approve / reject / undo. */
export type ReassignDecisionResponse = {
  result: 'approved' | 'rejected' | 'undone' | 'cancelled' | string;
  task: ReassignTaskPatch | null;
  people: TeamWorkloadPerson[];
};

// ─── Adapters ───────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const id = (v: unknown): number | null => {
  const n = num(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(id).filter((x): x is number => x != null) : []);
const userRef = (v: any): WorkloadUserRef | null => {
  const i = id(v?.id);
  return i == null ? null : { id: i, name: str(v?.name) ?? '' };
};

function normalizePending(raw: any): WorkloadPending | null {
  const pid = id(raw?.id);
  if (pid == null) return null;
  return {
    id: pid,
    fromUserId: id(raw.fromUserId),
    toUserId: id(raw.toUserId),
    toName: str(raw.toName),
    approver: userRef(raw.approver),
    requestedBy: userRef(raw.requestedBy),
    createdAt: str(raw.createdAt),
  };
}

export function normalizeTaskEntry(raw: any): WorkloadTaskEntry | null {
  const tid = id(raw?.id);
  if (tid == null) return null;
  let logged: Record<string, number> | null = null;
  if (raw.loggedHoursByUser && typeof raw.loggedHoursByUser === 'object') {
    logged = {};
    for (const [k, v] of Object.entries(raw.loggedHoursByUser)) {
      const h = num(v);
      if (h != null) logged[k] = h;
    }
  }
  const sid = id(raw.service?.id);
  return {
    id: tid,
    code: str(raw.code),
    name: typeof raw.name === 'string' ? raw.name : '',
    projectId: id(raw.projectId),
    projectName: str(raw.projectName),
    service: sid == null ? null : { id: sid, name: str(raw.service?.name) ?? '' },
    status: str(raw.status),
    estimatedStartDate: str(raw.estimatedStartDate),
    startDate: str(raw.startDate),
    endDate: str(raw.endDate),
    budgetHours: num(raw.budgetHours),
    remainingHours: num(raw.remainingHours),
    assigneeIds: ids(raw.assigneeIds),
    loggedUserIds: ids(raw.loggedUserIds),
    loggedHoursByUser: logged,
    overdue: raw.overdue === true,
    canDrag: raw.canDrag === true,
    pending: normalizePending(raw.pending),
    ...(typeof raw.isPersonal === 'boolean' ? { isPersonal: raw.isPersonal } : {}),
  };
}

export const EMPTY_ASSIGN: WorkloadAssign = { canAssign: false, projects: {}, services: {}, approvalsWaitingForMe: 0 };

function normalizeAssign(raw: any): WorkloadAssign {
  if (!raw || typeof raw !== 'object') return EMPTY_ASSIGN;
  const projects: WorkloadAssign['projects'] = {};
  for (const [k, v] of Object.entries(raw.projects ?? {})) {
    projects[k] = { canManage: (v as any)?.canManage === true, teamUserIds: ids((v as any)?.teamUserIds) };
  }
  const services: WorkloadAssign['services'] = {};
  for (const [k, v] of Object.entries(raw.services ?? {})) {
    services[k] = { requiredQualificationIds: ids((v as any)?.requiredQualificationIds) };
  }
  return {
    canAssign: raw.canAssign === true,
    projects,
    services,
    approvalsWaitingForMe: Math.max(0, num(raw.approvalsWaitingForMe) ?? 0),
  };
}

function normalizePerson(raw: any): TeamWorkloadPerson {
  return {
    ...raw,
    departmentId: id(raw?.departmentId),
    departmentName: str(raw?.departmentName),
    qualificationIds: ids(raw?.qualificationIds),
    canDragFrom: raw?.canDragFrom === true,
  };
}

/** `GET /workload/team`: the P3 payload plus the PR-063 additions, defaulted. */
export function normalizeTeamWorkload(raw: any): TeamWorkload {
  const tasks: Record<string, WorkloadTaskEntry> = {};
  for (const v of Object.values(raw?.tasks ?? {})) {
    const t = normalizeTaskEntry(v);
    if (t) tasks[String(t.id)] = t;
  }
  return {
    ...raw,
    people: Array.isArray(raw?.people) ? raw.people.map(normalizePerson) : [],
    days: Array.isArray(raw?.days) ? raw.days : [],
    tasks,
    assign: normalizeAssign(raw?.assign),
  };
}

export function normalizeReassignmentRequest(raw: any): ReassignmentRequest | null {
  const rid = id(raw?.id);
  const tid = id(raw?.task?.id);
  if (rid == null || tid == null) return null;
  const side = (s: any) => {
    const i = id(s?.id);
    return i == null ? null : { id: i, name: str(s?.name) ?? '', orgUnitName: str(s?.orgUnitName) };
  };
  return {
    id: rid,
    status: str(raw.status) ?? 'pending',
    task: {
      id: tid,
      code: str(raw.task.code),
      name: typeof raw.task.name === 'string' ? raw.task.name : '',
      projectId: id(raw.task.projectId),
      projectName: str(raw.task.projectName),
      hours: num(raw.task.hours),
    },
    from: side(raw.from),
    to: side(raw.to),
    fromDay: str(raw.fromDay),
    toDay: str(raw.toDay),
    newEstimatedStartDate: str(raw.newEstimatedStartDate),
    newEndDate: str(raw.newEndDate),
    requestedBy: userRef(raw.requestedBy),
    approver: userRef(raw.approver),
    createdAt: str(raw.createdAt),
    decidedAt: str(raw.decidedAt),
    decisionNote: str(raw.decisionNote),
  };
}

/** `GET /workload/tray`. */
export function normalizeTray(raw: any): WorkloadTray {
  const entries = (list: unknown) =>
    (Array.isArray(list) ? list : []).map(normalizeTaskEntry).filter((t): t is WorkloadTaskEntry => t != null);
  const overdueRaw: any[] = Array.isArray(raw?.overdue?.items) ? raw.overdue.items : [];
  const overdue: TrayOverdueItem[] = [];
  for (const r of overdueRaw) {
    const t = normalizeTaskEntry(r);
    const assigneeId = id(r?.assigneeId);
    if (t && assigneeId != null) overdue.push({ ...t, assigneeId, assigneeName: str(r.assigneeName) });
  }
  const unassigned = entries(raw?.unassigned?.items);
  return {
    unassigned: { total: Math.max(unassigned.length, num(raw?.unassigned?.total) ?? 0), items: unassigned },
    overdue: { total: Math.max(overdue.length, num(raw?.overdue?.total) ?? 0), items: overdue },
    approvals: (Array.isArray(raw?.approvals) ? raw.approvals : [])
      .map(normalizeReassignmentRequest)
      .filter((r: ReassignmentRequest | null): r is ReassignmentRequest => r != null),
  };
}

/**
 * Person rows of a write response, kept as sent: `applyPeopleRows`
 * spreads them over the board's row, so a field the response leaves out
 * (department, drag flag) keeps the board's value.
 */
function rawPeople(list: unknown): TeamWorkloadPerson[] {
  return (Array.isArray(list) ? list : []).filter(
    (p): p is TeamWorkloadPerson => !!p && typeof p === 'object' && id((p as any).id) != null && Array.isArray((p as any).days),
  );
}

function normalizeTaskPatch(raw: any): ReassignTaskPatch | null {
  const tid = id(raw?.id);
  if (tid == null) return null;
  return {
    id: tid,
    assigneeIds: ids(raw.assigneeIds),
    estimatedStartDate: str(raw.estimatedStartDate),
    endDate: str(raw.endDate),
    dueDateOverridden: raw.dueDateOverridden === true,
  };
}

/** `POST /tasks/:id/reassign` 200. */
export function normalizeReassignResponse(raw: any): ReassignResponse {
  const r = raw?.reassignment ?? {};
  const ls = raw?.loggedStays;
  const lsId = id(ls?.userId);
  return {
    result: raw?.result === 'pending' ? 'pending' : 'applied',
    reassignment: {
      id: id(r.id) ?? 0,
      status: str(r.status) ?? (raw?.result === 'pending' ? 'pending' : 'applied'),
      crossDepartment: r.crossDepartment === true,
      approver: userRef(r.approver),
      undoUntil: str(r.undoUntil),
    },
    task: normalizeTaskPatch(raw?.task),
    changed: { assignee: raw?.changed?.assignee === true, dates: raw?.changed?.dates === true },
    addedToTeam: raw?.addedToTeam === true,
    loggedStays: lsId == null ? null : { userId: lsId, name: str(ls.name) ?? '', hours: num(ls.hours) },
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : [])
      .map((w: any) => ({ code: str(w?.code) ?? 'WARNING', taskId: id(w?.taskId), message: str(w?.message) ?? '' }))
      .filter((w: ReassignWarning) => w.message !== ''),
    people: rawPeople(raw?.people),
  };
}

/** approve / reject / undo 200. */
export function normalizeDecisionResponse(raw: any): ReassignDecisionResponse {
  return {
    result: str(raw?.result) ?? 'done',
    task: normalizeTaskPatch(raw?.task),
    people: rawPeople(raw?.people),
  };
}

/**
 * Contract assumption (personal tasks): the `tasks` entry has no
 * personal flag in §10.4. A personal task is one the server marks
 * `isPersonal`, or one without a project. Never draggable (R8).
 */
export function isPersonalTask(task: Pick<WorkloadTaskEntry, 'projectId'> & { isPersonal?: boolean }): boolean {
  return task.isPersonal === true || task.projectId == null;
}
