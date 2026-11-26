/**
 * QA6 PR-063 — shapes of the Workload drag-and-drop contract
 * (docs/bm2/qa6-pr063-research.md §10.4 as amended by
 * qa6-pr063-locked-spec.md), shared by GET /workload/team,
 * GET /workload/tray and the TaskReassignService.
 *
 * Pure: no Prisma, no clock (callers pass `today`).
 */
import { VisibleUserIds, isUserVisible } from '../../common/services/employee-scope.service';
import { WorkloadTask, keyOf, normalizeIdList, resolveEffectiveServiceId, round2 } from './workload-engine';

/** How long an applied move can be undone (locked spec D9). */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

/** Tray groups and the approvals list are capped; `total` tells the rest. */
export const TRAY_LIST_CAP = 50;
export const REQUEST_LIST_CAP = 100;

export interface NamedRef {
  id: number;
  name: string;
}

export function personName(u: { id?: number; firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (!u) return '';
  const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
  return name || (u.id != null ? `User #${u.id}` : '');
}

function ref(u: { id: number; firstName?: string | null; lastName?: string | null } | null | undefined): NamedRef | null {
  return u ? { id: u.id, name: personName(u) } : null;
}

/** A service row as the gate reads it. */
export interface ServiceRow {
  id: number;
  name: string;
  kind?: string | null;
  requiredProfessionIds?: unknown;
}

/** The pending request a task chip shows ("APPROVAL → Yair"). */
export interface PendingRef {
  id: number;
  fromUserId: number | null;
  toUserId: number | null;
  toName: string | null;
  approver: NamedRef | null;
  requestedBy: NamedRef | null;
  createdAt: string;
}

/** `tasks[id]` of GET /workload/team, and the items of GET /workload/tray. */
export interface TaskEntry {
  id: number;
  code: string | null;
  name: string;
  projectId: number | null;
  projectName: string | null;
  service: NamedRef | null;
  status: string | null;
  estimatedStartDate: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetHours: number;
  remainingHours: number;
  assigneeIds: number[];
  loggedUserIds: number[];
  loggedHoursByUser: Record<string, number> | null;
  overdue: boolean;
  canDrag: boolean;
  pending: PendingRef | null;
}

export interface TaskEntryContext {
  today: string;
  isAdmin: boolean;
  /** Projects the caller leads (assertProjectManage without the Admin bypass). */
  ledProjectIds: Set<number>;
  /** Whose logged hours the caller may see (round 3). */
  visible: VisibleUserIds;
  services: Map<number, ServiceRow>;
  /** Pending request per task id (rows selected with REQUEST_SELECT). */
  pendingByTask: Map<number, any>;
}

/** The effective service of a task as the gate reads it; `kind = 'phase'` rows count as none. */
export function effectiveService(t: WorkloadTask, services: Map<number, ServiceRow>): ServiceRow | null {
  const id = resolveEffectiveServiceId(t);
  const svc = id != null ? services.get(id) : undefined;
  return svc && svc.kind !== 'phase' ? svc : null;
}

export function buildTaskEntry(t: WorkloadTask, ctx: TaskEntryContext): TaskEntry {
  const pendingRow = ctx.pendingByTask.get(t.id) ?? null;
  const svc = effectiveService(t, ctx.services);
  const logged = t.loggedByUser ?? new Map<number, number>();
  const loggedUserIds = [...logged.entries()]
    .filter(([, h]) => h > 0)
    .map(([u]) => u)
    .sort((a, b) => a - b);
  // Hours per person only for people the caller may see, or all of them
  // for the project's leader (the round-3 rule / toLeaderView).
  const leads = t.projectId != null && ctx.ledProjectIds.has(t.projectId);
  let byUser: Record<string, number> | null = null;
  for (const uid of loggedUserIds) {
    if (!leads && !isUserVisible(ctx.visible, uid)) continue;
    (byUser ??= {})[String(uid)] = round2(logged.get(uid) ?? 0);
  }
  const budget = Number(t.budgetHours) || 0;
  const end = keyOf(t.endDate as any);
  const projectTask = t.projectId != null && t.isPersonal !== true;
  return {
    id: t.id,
    code: t.code ?? null,
    name: t.name,
    projectId: t.projectId ?? null,
    projectName: t.projectName ?? null,
    service: svc ? { id: svc.id, name: svc.name } : null,
    status: t.status ?? null,
    estimatedStartDate: keyOf(t.estimatedStartDate as any),
    startDate: keyOf(t.startDate as any),
    endDate: end,
    budgetHours: round2(budget),
    remainingHours: round2(Math.max(0, budget - (Number(t.loggedHours) || 0))),
    assigneeIds: [...(t.assigneeIds ?? [])],
    loggedUserIds,
    loggedHoursByUser: byUser,
    overdue: end != null && end < ctx.today,
    canDrag: projectTask && !pendingRow && (ctx.isAdmin || ctx.ledProjectIds.has(t.projectId as number)),
    pending: pendingRow ? shapePending(pendingRow) : null,
  };
}

/** Services with a qualification requirement → `assign.services`. */
export function servicesWithRequirement(services: Map<number, ServiceRow>): Record<string, { requiredQualificationIds: number[] }> {
  const out: Record<string, { requiredQualificationIds: number[] }> = {};
  for (const s of services.values()) {
    if (s.kind === 'phase') continue;
    const ids = normalizeIdList(s.requiredProfessionIds);
    if (ids.length > 0) out[String(s.id)] = { requiredQualificationIds: ids };
  }
  return out;
}

// ─── Reassignment requests ───────────────────────────────────────────

const USER_REF = { select: { id: true, firstName: true, lastName: true } } as const;
const USER_WITH_UNIT = {
  select: { id: true, firstName: true, lastName: true, orgUnit: { select: { name: true } } },
} as const;

/** Columns + relations every shape below reads. */
export const REQUEST_SELECT = {
  id: true,
  taskId: true,
  projectId: true,
  actorId: true,
  fromUserId: true,
  toUserId: true,
  fromDay: true,
  toDay: true,
  prevAssigneeIds: true,
  newAssigneeIds: true,
  prevEstimatedStartDate: true,
  prevEndDate: true,
  prevDueDateOverridden: true,
  newEstimatedStartDate: true,
  newEndDate: true,
  newDueDateOverridden: true,
  addedToTeam: true,
  crossDepartment: true,
  fromOrgUnitId: true,
  toOrgUnitId: true,
  approverUserId: true,
  status: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  task: {
    select: { id: true, code: true, name: true, projectId: true, budgetHours: true, project: { select: { name: true } } },
  },
  fromUser: USER_WITH_UNIT,
  toUser: USER_WITH_UNIT,
  actor: USER_REF,
  approver: USER_REF,
  decidedBy: USER_REF,
} as const;

const iso = (d: Date | string | null | undefined): string | null => {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

export function shapePending(row: any): PendingRef {
  return {
    id: row.id,
    fromUserId: row.fromUserId ?? null,
    toUserId: row.toUserId ?? null,
    toName: row.toUser ? personName(row.toUser) : null,
    approver: ref(row.approver),
    requestedBy: ref(row.actor),
    createdAt: iso(row.createdAt) ?? '',
  };
}

export interface ReassignmentRequest {
  id: number;
  status: string;
  task: {
    id: number;
    code: string | null;
    name: string;
    projectId: number | null;
    projectName: string | null;
    hours: number;
  };
  from: { id: number; name: string; orgUnitName: string | null } | null;
  to: { id: number; name: string; orgUnitName: string | null } | null;
  fromDay: string | null;
  toDay: string | null;
  newEstimatedStartDate: string | null;
  newEndDate: string | null;
  crossDepartment: boolean;
  requestedBy: NamedRef | null;
  approver: NamedRef | null;
  createdAt: string | null;
  decidedAt: string | null;
  decidedBy: NamedRef | null;
  decisionNote: string | null;
}

/**
 * A request as the approver / requester lists show it. Locked spec D11:
 * the task's code, name, project name and hours travel with the request
 * even when the approver cannot open the project; nothing else of it.
 */
export function shapeReassignmentRequest(row: any): ReassignmentRequest {
  const person = (u: any) =>
    u ? { id: u.id, name: personName(u), orgUnitName: u.orgUnit?.name ?? null } : null;
  return {
    id: row.id,
    status: String(row.status),
    task: {
      id: row.task?.id ?? row.taskId,
      code: row.task?.code ?? null,
      name: row.task?.name ?? '',
      projectId: row.task?.projectId ?? row.projectId ?? null,
      projectName: row.task?.project?.name ?? null,
      hours: round2(Number(row.task?.budgetHours ?? 0) || 0),
    },
    from: person(row.fromUser),
    to: person(row.toUser),
    fromDay: keyOf(row.fromDay),
    toDay: keyOf(row.toDay),
    newEstimatedStartDate: keyOf(row.newEstimatedStartDate),
    newEndDate: keyOf(row.newEndDate),
    crossDepartment: row.crossDepartment === true,
    requestedBy: ref(row.actor),
    approver: ref(row.approver),
    createdAt: iso(row.createdAt),
    decidedAt: iso(row.decidedAt),
    decidedBy: ref(row.decidedBy),
    decisionNote: row.decisionNote ?? null,
  };
}

/**
 * Pending requests a caller may decide (locked spec D2): the resolved
 * approver, anyone in the receiving person's manager chain, or an Admin
 * (every request, including those with no approver).
 * `managedUserIds` = the caller's current subordinates (+ himself when
 * he manages a unit on his own path).
 */
export function decidableWhere(caller: { id: number; isAdmin: boolean }, managedUserIds: Iterable<number>): any {
  if (caller.isAdmin) return {};
  const managed = [...new Set([...managedUserIds].map(Number))];
  return {
    OR: [
      { approverUserId: caller.id },
      ...(managed.length > 0 ? [{ toUserId: { in: managed } }] : []),
    ],
  };
}

export function canDecideRow(
  row: { approverUserId?: number | null; toUserId?: number | null },
  caller: { id: number; isAdmin: boolean },
  managedUserIds: Set<number>,
): boolean {
  if (caller.isAdmin) return true;
  if (row.approverUserId != null && row.approverUserId === caller.id) return true;
  return row.toUserId != null && managedUserIds.has(row.toUserId);
}
