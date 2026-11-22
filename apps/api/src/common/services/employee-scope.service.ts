import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { userHasModulePermission } from '../guards/roles.guard';
import { PermissionDeniedException } from '../errors/permission-denied';

/**
 * Permissions round 3 — privacy (2026-11-22).
 *
 * Who may see (and manage) another employee's attendance (clock
 * records) and timesheets (time entries). The owner's rules:
 *
 *   VIEW     — the employee himself; anyone with `hr:read`; or a
 *              manager of the employee's org unit or of any ancestor
 *              unit (the "manager chain"). Managing a unit is enough —
 *              no extra permission. Admin gets NO exception (`hr` is in
 *              the RolesGuard's NO_ADMIN_BYPASS and
 *              `userHasModulePermission` never short-circuits admins).
 *   EDIT     — attendance of someone else: `hr:write` or the chain.
 *   APPROVE  — attendance of someone else: `hr:approve` or the chain;
 *              never one's own record.
 *
 * Project leaders additionally see time entries on the projects they
 * lead (date, task, hours, note — see `toLeaderView`). That is NOT an
 * employee-level grant, so it lives beside the employee rules
 * (`ledProjectIds`) and each caller decides where it applies.
 *
 * Everything here is computed FRESH on every call. The
 * `ProjectAccessService.getSubordinateUserIds` memo lives for the
 * process and is not cleared when a user's home unit changes, so it
 * must never decide who sees whose hours.
 */

/** `'all'` = every employee (hr:read); otherwise the user ids the caller may see. */
export type VisibleUserIds = 'all' | number[];

/** Scope of a time-entry listing: employees the caller sees + projects he leads. */
export interface TimeEntryScope {
  visibleUserIds: VisibleUserIds;
  ledProjectIds: number[];
}

/** Sees nobody, leads nothing — the fail-closed default for services. */
export const NO_TIME_SCOPE: TimeEntryScope = Object.freeze({
  visibleUserIds: [] as number[],
  ledProjectIds: [] as number[],
}) as TimeEntryScope;

/** Sees everybody — for tests and HR-only internals. */
export const ALL_TIME_SCOPE: TimeEntryScope = Object.freeze({
  visibleUserIds: 'all',
  ledProjectIds: [] as number[],
}) as TimeEntryScope;

export function isUserVisible(visible: VisibleUserIds, userId: number): boolean {
  return visible === 'all' || visible.includes(Number(userId));
}

/**
 * Fields a project leader may NOT see on someone else's time entry:
 * location, the special-hours bucket and anything tied to attendance
 * (the clock record link and the time-of-day window). What stays is
 * the owner's whitelist: date, task, hours, note (plus the ids and
 * names needed to render them).
 */
export const LEADER_HIDDEN_ENTRY_KEYS = [
  'location',
  'specialHourBucketId',
  'specialHourBucket',
  'timeClockId',
  'timeClock',
  'startTime',
  'endTime',
] as const;

/** A time entry as a project leader sees it. Pure, never mutates. */
export function toLeaderView<T extends Record<string, any>>(entry: T): T {
  const out: Record<string, any> = { ...entry };
  for (const key of LEADER_HIDDEN_ENTRY_KEYS) {
    if (key in out) delete out[key];
  }
  return out as T;
}

/** Ids on a materialised path like "/1/5/12/" → [1, 5, 12]. */
function idsOnPath(path: string | null | undefined): number[] {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

type Caller = { id: number; roleModules?: any[]; isAdmin?: boolean } & Record<string, any>;

@Injectable()
export class EmployeeScopeService {
  constructor(private readonly prisma: PrismaService) {}

  hasHr(caller: Caller, action: 'read' | 'write' | 'approve'): boolean {
    return userHasModulePermission(caller, 'hr', action);
  }

  /**
   * Is `callerId` a manager of the target's home unit or of any unit
   * above it? Uncached: reads the target's unit path, then looks for a
   * live unit on that path (the target's own unit included) whose
   * manager is the caller. A user who is nobody's manager costs one
   * small query.
   */
  async isInManagerChain(callerId: number, targetUserId: number): Promise<boolean> {
    if (!Number.isFinite(Number(targetUserId))) return false;
    const target = await this.prisma.user.findUnique({
      where: { id: Number(targetUserId) },
      select: { orgUnitId: true, orgUnit: { select: { path: true } } },
    });
    if (!target?.orgUnitId) return false;
    const unitIds = new Set<number>(idsOnPath(target.orgUnit?.path));
    // `path` defaults to "/" on a unit the tree service never rewrote;
    // the home unit itself always counts.
    unitIds.add(target.orgUnitId);
    const managed = await this.prisma.orgUnit.count({
      where: { id: { in: [...unitIds] }, managerUserId: callerId, deletedAt: null },
    });
    return managed > 0;
  }

  /** Self, `hr:read`, or the manager chain. */
  async canViewEmployee(caller: Caller, targetUserId: number): Promise<boolean> {
    if (Number(targetUserId) === caller.id) return true;
    if (this.hasHr(caller, 'read')) return true;
    return this.isInManagerChain(caller.id, targetUserId);
  }

  /** Someone else's attendance: `hr:write` or the manager chain. */
  async canEditAttendance(caller: Caller, targetUserId: number): Promise<boolean> {
    if (Number(targetUserId) === caller.id) return false;
    if (this.hasHr(caller, 'write')) return true;
    return this.isInManagerChain(caller.id, targetUserId);
  }

  /** Someone else's attendance: `hr:approve` or the manager chain. Never one's own. */
  async canApproveAttendance(caller: Caller, targetUserId: number): Promise<boolean> {
    if (Number(targetUserId) === caller.id) return false;
    if (this.hasHr(caller, 'approve')) return true;
    return this.isInManagerChain(caller.id, targetUserId);
  }

  /**
   * Users whose home unit sits in a live unit the caller manages, or
   * anywhere below one. Fresh every call (no memo). Excludes the caller.
   * A managed unit whose `path` was never written ("/") contributes only
   * itself — `startsWith('/')` would match the whole tree.
   */
  async currentSubordinateIds(callerId: number): Promise<number[]> {
    const managed = await this.prisma.orgUnit.findMany({
      where: { managerUserId: callerId, deletedAt: null },
      select: { id: true, path: true },
    });
    if (managed.length === 0) return [];
    // Descendant units are NOT filtered on deletedAt, matching
    // isInManagerChain (only the managed unit itself must be live).
    const subtree = await this.prisma.orgUnit.findMany({
      where: {
        OR: [
          { id: { in: managed.map((u) => u.id) } },
          ...managed
            .map((u) => idsOnPath(u.path))
            .filter((ids) => ids.length > 0)
            // Normalised "/1/5/" so a path missing its trailing "/" can't
            // match a sibling ("/1/5" vs "/1/50/").
            .map((ids) => ({ path: { startsWith: `/${ids.join('/')}/` } })),
        ],
      },
      select: { id: true },
    });
    const unitIds = [...new Set(subtree.map((u) => u.id))];
    if (unitIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { orgUnitId: { in: unitIds }, id: { not: callerId } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** `'all'` for `hr:read`, otherwise [self, ...current subordinates]. */
  async visibleUserIds(caller: Caller): Promise<VisibleUserIds> {
    if (this.hasHr(caller, 'read')) return 'all';
    const subs = await this.currentSubordinateIds(caller.id);
    return [...new Set([caller.id, ...subs])];
  }

  /** Live projects whose leader is the caller (the leader only, not every member). */
  async ledProjectIds(callerId: number): Promise<number[]> {
    const rows = await this.prisma.project.findMany({
      where: { leaderId: callerId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((p) => p.id);
  }

  async isProjectLeader(callerId: number, projectId: number | null | undefined): Promise<boolean> {
    if (projectId == null) return false;
    const project = await this.prisma.project.findFirst({
      where: { id: Number(projectId), deletedAt: null },
      select: { leaderId: true },
    });
    return project?.leaderId === callerId;
  }

  /** Visible employees + led projects, for time-entry listings. */
  async timeEntryScope(caller: Caller): Promise<TimeEntryScope> {
    const visibleUserIds = await this.visibleUserIds(caller);
    if (visibleUserIds === 'all') return { visibleUserIds, ledProjectIds: [] };
    return { visibleUserIds, ledProjectIds: await this.ledProjectIds(caller.id) };
  }

  /** Throws PERMISSION_DENIED unless `canViewEmployee`. */
  async assertCanViewEmployee(
    caller: Caller,
    targetUserId: number,
    what: 'attendance' | 'time entries' | 'workload' | 'attendance and time entries' = 'attendance and time entries',
  ): Promise<void> {
    if (await this.canViewEmployee(caller, targetUserId)) return;
    throw notInManagerChain(what);
  }
}

/** "You can only view <what> of employees you manage." */
export function notInManagerChain(
  what: string = 'attendance and time entries',
  verb: string = 'view',
): PermissionDeniedException {
  return new PermissionDeniedException(
    `You can only ${verb} ${what} of employees you manage. Ask HR if you need access.`,
    { reason: 'NOT_IN_MANAGER_CHAIN' },
  );
}
