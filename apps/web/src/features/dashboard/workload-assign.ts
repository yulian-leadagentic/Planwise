import { addDays, format, parseISO } from 'date-fns';
import { dayColumn, utilizationPct, type TeamWorkload, type TeamWorkloadChip, type TeamWorkloadDay, type TeamWorkloadPerson } from './workload-range';
import {
  isPersonalTask,
  type ReassignBody,
  type ReassignResponse,
  type ReassignTaskPatch,
  type ReassignView,
  type WorkloadAssign,
  type WorkloadPending,
  type WorkloadTaskEntry,
  type WorkloadTray,
} from './workload-contract';

/**
 * QA6 P4 (PR-063): the pure rules of the Workload drag-and-drop. Who may
 * pick a chip up, where it may land (service gate, project Team,
 * department approval), the before→after preview, the tray's "Causing
 * overload" group, and the optimistic board update. The server re-checks
 * every write; these only drive the screen.
 */

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Drag sources ───────────────────────────────────────────────────────

export type DragOrigin = 'lane' | 'unassigned' | 'overdue' | 'overload';

export type DragSource = {
  taskId: number;
  /** null = an unassigned tray chip. */
  fromUserId: number | null;
  /** null = a tray chip (no source column on screen). */
  fromDay: string | null;
  /** The chip's hours (the per-day share), for the preview. */
  hours: number;
  origin: DragOrigin;
};

/**
 * May the caller pick this chip up? The server's rule:
 * `pending == null && projectId != null && (tasks[id].canDrag || people[lane].canDragFrom)`.
 * Masked chips (no entry) never move. `canDrag` is the project-manage
 * part (Admin / leader, already false for pending and personal tasks);
 * `canDragFrom` is the manager chain of the person the chip belongs to.
 * An unassigned tray chip has no person: leader / Admin only.
 * (`assign.canAssign` is not a gate: it covers board chips only, and a
 * tray task can be draggable while no board chip is.)
 */
export function canDragChip(
  task: WorkloadTaskEntry | null | undefined,
  person: Pick<TeamWorkloadPerson, 'canDragFrom'> | null | undefined,
): boolean {
  if (!task) return false;
  if (task.pending) return false;
  if (isPersonalTask(task)) return false;
  return task.canDrag || person?.canDragFrom === true;
}

/**
 * The project Teams the drop check reads: the board's `assign.projects`
 * plus the tray's (a tray task's project may be missing from the board's
 * index). Same shape; on overlap the Team lists are joined and either
 * `canManage` counts.
 */
export function mergeAssignProjects(
  board: WorkloadAssign['projects'],
  tray: WorkloadAssign['projects'] | null | undefined,
): WorkloadAssign['projects'] {
  if (!tray || Object.keys(tray).length === 0) return board;
  const out: WorkloadAssign['projects'] = { ...tray };
  for (const [pid, p] of Object.entries(board)) {
    const t = out[pid];
    out[pid] = t
      ? { canManage: p.canManage || t.canManage, teamUserIds: [...new Set([...p.teamUserIds, ...t.teamUserIds])] }
      : p;
  }
  return out;
}

// ─── Drop rules ─────────────────────────────────────────────────────────

/**
 * Locked spec › Service gate: true when the task has no effective
 * service (a phase arrives as null) or the service has no requirement;
 * otherwise the person must hold at least one of the qualifications.
 */
export function providesService(
  person: Pick<TeamWorkloadPerson, 'qualificationIds'>,
  task: Pick<WorkloadTaskEntry, 'service'>,
  services: WorkloadAssign['services'],
): boolean {
  const sid = task.service?.id;
  if (sid == null) return true;
  const required = services[String(sid)]?.requiredQualificationIds ?? [];
  if (required.length === 0) return true;
  const held = person.qualificationIds ?? [];
  return held.some((q) => required.includes(q));
}

/** D1: the top-level unit; everyone without one shares "No department". */
export function departmentKey(person: Pick<TeamWorkloadPerson, 'departmentId'>): string {
  return person.departmentId == null ? 'none' : String(person.departmentId);
}

export type DropReason = 'same-cell' | 'not-working-day' | 'service' | 'team';

export type DropCheck = {
  ok: boolean;
  reason: DropReason | null;
  /**
   * Cross-department move (D1): a move from A (a lane chip, or an overdue
   * tray item, which belongs to A) to someone in another department. Never
   * for an unassigned tray chip or a drop on the tray (D4).
   */
  crossDept: boolean;
  /** Cross-department and the caller is not Admin / in the target's chain (D3). */
  needsApproval: boolean;
  /** Not on the project Team, and the caller manages the project: the move adds him. */
  addsToTeam: boolean;
};

export type DropContext = {
  source: Pick<DragSource, 'fromUserId' | 'fromDay'>;
  /** The drop column; null checks the row only (dimming). */
  toDay: string | null;
  assign: Pick<WorkloadAssign, 'projects' | 'services'>;
  /** The person the chip comes from (null for an unassigned tray chip). */
  fromPerson: Pick<TeamWorkloadPerson, 'id' | 'departmentId'> | null;
  /** The drop column's org day (holiday / rest day refuses the drop). */
  day?: Pick<TeamWorkloadDay, 'isWorkingDay'> | null;
};

const BLOCK = (reason: DropReason): DropCheck => ({ ok: false, reason, crossDept: false, needsApproval: false, addsToTeam: false });

/**
 * Can `task` be dropped on `person` (on `ctx.toDay`)? The drop column
 * must be an org working day (server 400 REASSIGN_INVALID_DAY). A date
 * move inside the same row needs nothing else. A move to someone else
 * also needs the service and the project Team (locked spec ›
 * Permissions), unless he is already an assignee of the task: then the
 * server only removes A and checks nothing for him.
 */
export function dropCheck(
  person: Pick<TeamWorkloadPerson, 'id' | 'departmentId' | 'qualificationIds' | 'canDragFrom'>,
  task: Pick<WorkloadTaskEntry, 'projectId' | 'service' | 'canDrag' | 'assigneeIds'>,
  ctx: DropContext,
): DropCheck {
  const samePerson = ctx.source.fromUserId != null && ctx.source.fromUserId === person.id;
  if (ctx.toDay != null) {
    if (samePerson && ctx.source.fromDay === ctx.toDay) return BLOCK('same-cell');
    if (ctx.day && ctx.day.isWorkingDay === false) return BLOCK('not-working-day');
  }
  if (samePerson) return { ok: true, reason: null, crossDept: false, needsApproval: false, addsToTeam: false };

  const alreadyAssigned = task.assigneeIds.includes(person.id);
  let onTeam = true;
  if (!alreadyAssigned) {
    if (!providesService(person, task, ctx.assign.services)) return BLOCK('service');
    const project = task.projectId == null ? undefined : ctx.assign.projects[String(task.projectId)];
    onTeam = project?.teamUserIds.includes(person.id) ?? false;
    // A project missing from both blocks: the task's own manage flag decides.
    const canManage = project?.canManage ?? task.canDrag;
    if (!onTeam && !canManage) return BLOCK('team');
  }

  // D1 applies to every move from A to B (the merge case included); D4:
  // an unassigned tray chip (no A) never waits.
  const crossDept = ctx.source.fromUserId != null && ctx.fromPerson != null && departmentKey(ctx.fromPerson) !== departmentKey(person);
  return {
    ok: true,
    reason: null,
    crossDept,
    needsApproval: crossDept && person.canDragFrom !== true,
    addsToTeam: !onTeam,
  };
}

/** The words a blocked row / cell shows. */
export function dropReasonText(reason: DropReason, task?: Pick<WorkloadTaskEntry, 'service'> | null): string {
  switch (reason) {
    case 'same-cell':
      return 'Current day';
    case 'not-working-day':
      return 'Not a working day';
    case 'service':
      return task?.service?.name ? `Does not provide ${task.service.name}` : 'Does not provide this service';
    case 'team':
      return 'Not on the project team';
  }
}

// ─── Preview ────────────────────────────────────────────────────────────

export type DayPreview = { before: number; after: number; over: boolean; off: boolean };

/**
 * "before→after%" for one person-day if the dragged chip lands there.
 * Hours of the same task already in the cell (a multi-day task) are not
 * counted twice. Approximate: the server response is the truth.
 */
export function previewPct(
  cell: { planned: number; capacity: number; sameTaskHours?: number },
  dragHours: number,
): DayPreview {
  const afterHours = Math.max(0, cell.planned - (cell.sameTaskHours ?? 0)) + Math.max(0, dragHours);
  const off = !(cell.capacity > 0);
  const before = utilizationPct(cell.planned, cell.capacity);
  const after = utilizationPct(afterHours, cell.capacity);
  return { before, after, over: off ? afterHours > EPS : afterHours > cell.capacity + EPS, off };
}

// ─── Tray: causing overload ─────────────────────────────────────────────

export type OverloadItem = { taskId: number; personId: number; day: string; hours: number };

/**
 * The tray's third group: for every person-day above capacity (the
 * engine's rule, `planned > capacity`), its smallest movable chip. A task
 * shows once per person.
 */
export function overloadCausing(
  people: TeamWorkloadPerson[],
  tasks: Record<string, WorkloadTaskEntry>,
): OverloadItem[] {
  const out: OverloadItem[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    for (const d of p.days) {
      if (!(d.planned > 0 && d.planned > d.capacity + EPS)) continue;
      const candidates = d.tasks
        .filter((c) => c.taskId != null && !c.masked && tasks[String(c.taskId)] && !tasks[String(c.taskId)].pending)
        .sort((a, b) => a.hours - b.hours || (a.taskId as number) - (b.taskId as number));
      const pick = candidates[0];
      if (!pick) continue;
      const key = `${pick.taskId}:${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ taskId: pick.taskId as number, personId: p.id, day: d.date, hours: pick.hours });
    }
  }
  return out;
}

// ─── Days ───────────────────────────────────────────────────────────────

/** Signed number of working-day columns from `fromDay` to `toDay`; null when either is not one. */
export function workingDayDelta(days: Pick<TeamWorkloadDay, 'date' | 'isWorkingDay'>[], fromDay: string, toDay: string): number | null {
  const work = days.filter((d) => d.isWorkingDay !== false).map((d) => d.date);
  const a = work.indexOf(fromDay);
  const b = work.indexOf(toDay);
  return a < 0 || b < 0 ? null : b - a;
}

/** "Tue 24/11". */
export function dayLabel(date: string): string {
  const c = dayColumn(date);
  return `${c.weekday} ${c.date}`;
}

function isRestDay(date: string, restDays: number[]): boolean {
  return restDays.includes(parseISO(date).getDay());
}

/** Working days from `start` to `end` inclusive (rest days of the org week skipped; holidays ignored). */
export function workingDaysBetween(start: string, end: string, restDays: number[]): number {
  if (end < start) return 0;
  let n = 0;
  for (let d = parseISO(start); format(d, 'yyyy-MM-dd') <= end && n < 400; d = addDays(d, 1)) {
    if (!restDays.includes(d.getDay())) n++;
  }
  return n;
}

/** `n` working days starting on `start` (itself first when it is one). */
export function nextWorkingDays(start: string, n: number, restDays: number[]): string[] {
  const out: string[] = [];
  for (let d = parseISO(start), guard = 0; out.length < n && guard < 400; d = addDays(d, 1), guard++) {
    const key = format(d, 'yyyy-MM-dd');
    if (!isRestDay(key, restDays)) out.push(key);
  }
  return out;
}

// ─── Request body ───────────────────────────────────────────────────────

/**
 * The `POST /tasks/:id/reassign` body for a drop.
 * Contract assumption (overdue tray chips): §10.4 lists one overdue item
 * per (task, assignee). Such a chip is sent with its `assigneeId` as
 * `fromUserId` and `fromDay: null` (no column on screen), so the server
 * applies the tray date rule (D6) to a real reassign.
 */
export function reassignBody(
  source: Pick<DragSource, 'fromUserId' | 'fromDay'>,
  target: { userId: number; day: string } | null,
  view: ReassignView,
): ReassignBody {
  return {
    fromUserId: source.fromUserId,
    toUserId: target ? target.userId : null,
    fromDay: source.fromDay,
    toDay: target ? target.day : null,
    view: { from: view.from, to: view.to },
  };
}

// ─── Optimistic board update ────────────────────────────────────────────

export type OptimisticMove = {
  task: WorkloadTaskEntry;
  fromUserId: number | null;
  toUserId: number | null;
  fromDay: string | null;
  toDay: string | null;
  /** Set when the move will wait for approval: only the badge changes (A keeps the load). */
  pending?: WorkloadPending | null;
};

function withTotals(p: TeamWorkloadPerson): TeamWorkloadPerson {
  const planned = round2(p.days.reduce((s, d) => s + d.planned, 0));
  return {
    ...p,
    totals: {
      ...p.totals,
      planned,
      utilizationPct: utilizationPct(planned, p.totals.capacity),
      overloadedDays: p.days.filter((d) => d.planned > 0 && d.planned > d.capacity + EPS).length,
    },
  };
}

function withTeamTotals(data: TeamWorkload, people: TeamWorkloadPerson[]): TeamWorkload['totals'] {
  const before = data.people.reduce((s, p) => s + p.totals.planned, 0);
  const after = people.reduce((s, p) => s + p.totals.planned, 0);
  const planned = round2(data.totals.planned + (after - before));
  return { ...data.totals, planned, utilizationPct: utilizationPct(planned, data.totals.capacity) };
}

function chipFor(task: WorkloadTaskEntry, hours: number): TeamWorkloadChip {
  return { taskId: task.id, code: task.code, name: task.name, projectId: task.projectId, projectName: task.projectName, hours: round2(hours) };
}

/**
 * Where a tray chip lands (no source column). D6: the drop day inside a
 * window that is not overdue keeps the dates; otherwise the window starts
 * on the drop day with its working-day length. Remaining hours spread
 * evenly, as the engine does.
 */
export function trayLandingDays(
  task: Pick<WorkloadTaskEntry, 'estimatedStartDate' | 'startDate' | 'endDate' | 'overdue' | 'remainingHours' | 'budgetHours'>,
  toDay: string,
  restDays: number[],
): Array<{ date: string; hours: number }> {
  const remaining = task.remainingHours ?? task.budgetHours ?? 0;
  if (!(remaining > 0)) return [];
  const start = task.estimatedStartDate ?? task.startDate ?? task.endDate;
  const end = task.endDate;
  let dates: string[];
  if (start && end && !task.overdue && toDay >= start && toDay <= end) {
    const len = Math.max(1, workingDaysBetween(start, end, restDays));
    dates = nextWorkingDays(start, len, restDays);
  } else {
    const len = start && end ? Math.max(1, workingDaysBetween(start, end, restDays)) : 1;
    dates = nextWorkingDays(toDay, len, restDays);
  }
  const per = remaining / Math.max(1, dates.length);
  return dates.map((date) => ({ date, hours: per }));
}

/**
 * The board right after a drop, before the server answers. A → B moves
 * A's chips of the task to B (shifted by the working-day delta when the
 * column changed); a tray chip lands by `trayLandingDays`; a drop on the
 * tray takes A's chips off. A pending move only gets the badge.
 */
export function applyOptimisticMove(data: TeamWorkload, move: OptimisticMove): TeamWorkload {
  const key = String(move.task.id);
  const tasks = { ...(data.tasks ?? {}) };
  const entry = tasks[key] ?? move.task;

  if (move.pending) {
    tasks[key] = { ...entry, pending: move.pending };
    return { ...data, tasks };
  }

  const dates = data.days.map((d) => d.date);
  const work = data.days.filter((d) => d.isWorkingDay !== false).map((d) => d.date);
  const delta = move.fromDay && move.toDay ? workingDayDelta(data.days, move.fromDay, move.toDay) ?? 0 : 0;

  // 1. Take the task off the source person.
  const removed = new Map<string, number>();
  let people = data.people.map((p) => {
    if (move.fromUserId == null || p.id !== move.fromUserId) return p;
    const days = p.days.map((d) => {
      const mine = d.tasks.filter((c) => c.taskId === move.task.id);
      if (mine.length === 0) return d;
      const hours = mine.reduce((s, c) => s + c.hours, 0);
      removed.set(d.date, (removed.get(d.date) ?? 0) + hours);
      return { ...d, planned: round2(Math.max(0, d.planned - hours)), tasks: d.tasks.filter((c) => c.taskId !== move.task.id) };
    });
    return withTotals({ ...p, days });
  });

  // 2. Put it on the target person.
  if (move.toUserId != null && move.toDay) {
    const landing = new Map<string, number>();
    if (move.fromUserId != null && move.fromDay) {
      for (const [date, hours] of removed) {
        const i = work.indexOf(date);
        const target = i < 0 ? date : work[i + delta];
        if (target && dates.includes(target)) landing.set(target, (landing.get(target) ?? 0) + hours);
      }
    } else {
      for (const l of trayLandingDays(entry, move.toDay, data.workWeek?.restDays ?? [])) {
        if (dates.includes(l.date)) landing.set(l.date, (landing.get(l.date) ?? 0) + l.hours);
      }
    }
    people = people.map((p) => {
      if (p.id !== move.toUserId || landing.size === 0) return p;
      const days = p.days.map((d) => {
        const add = landing.get(d.date);
        if (!add) return d;
        const existing = d.tasks.find((c) => c.taskId === move.task.id);
        const chips = existing
          ? d.tasks.map((c) => (c === existing ? { ...c, hours: round2(c.hours + add) } : c))
          : [...d.tasks, chipFor(entry, add)];
        return { ...d, planned: round2(d.planned + add), tasks: chips };
      });
      return withTotals({ ...p, days });
    });
  }

  const assigneeIds = entry.assigneeIds.filter((uid) => uid !== move.fromUserId);
  if (move.toUserId != null && !assigneeIds.includes(move.toUserId)) assigneeIds.push(move.toUserId);
  tasks[key] = { ...entry, assigneeIds };

  return { ...data, people, tasks, totals: withTeamTotals(data, people) };
}

/** Server rows for the people a write touched (same masking as the board), spread over the board rows. */
export function applyPeopleRows(data: TeamWorkload, rows: TeamWorkloadPerson[]): TeamWorkload {
  if (rows.length === 0) return data;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const people = data.people.map((p) => {
    const row = byId.get(p.id);
    if (!row) return p;
    // A row over another range (the user changed week meanwhile) is ignored.
    const same = row.days.length === p.days.length && row.days.every((d, i) => d.date === p.days[i].date);
    return same ? { ...p, ...row } : p;
  });
  return { ...data, people, totals: withTeamTotals(data, people) };
}

/** The task as the server left it; `pending` is the request a pending move created (or null). */
export function applyTaskPatch(
  data: TeamWorkload,
  patch: ReassignTaskPatch | null,
  pending: WorkloadPending | null | undefined,
  taskId: number,
): TeamWorkload {
  const key = String(patch?.id ?? taskId);
  const entry = data.tasks?.[key];
  if (!entry) return data;
  const next: WorkloadTaskEntry = { ...entry };
  if (patch) {
    next.assigneeIds = patch.assigneeIds;
    next.estimatedStartDate = patch.estimatedStartDate;
    next.endDate = patch.endDate;
  }
  if (pending !== undefined) next.pending = pending;
  return { ...data, tasks: { ...data.tasks, [key]: next } };
}

/** The tray right after a drop: an assigned chip leaves its group, an unassigned one joins "Unassigned". */
export function applyTrayMove(tray: WorkloadTray, move: OptimisticMove & { origin: DragOrigin }): WorkloadTray {
  if (move.pending) return tray;
  const id = move.task.id;
  let { unassigned, overdue } = tray;
  if (move.origin === 'unassigned' && move.toUserId != null) {
    const items = unassigned.items.filter((t) => t.id !== id);
    unassigned = { total: Math.max(0, unassigned.total - (unassigned.items.length - items.length)), items };
  }
  if (move.fromUserId != null && (move.origin === 'overdue' || move.toUserId == null)) {
    const items = overdue.items.filter((t) => !(t.id === id && t.assigneeId === move.fromUserId));
    overdue = { total: Math.max(0, overdue.total - (overdue.items.length - items.length)), items };
  }
  if (move.toUserId == null && move.fromUserId != null) {
    const remaining = move.task.assigneeIds.filter((uid) => uid !== move.fromUserId);
    if (remaining.length === 0 && !unassigned.items.some((t) => t.id === id)) {
      unassigned = { total: unassigned.total + 1, items: [{ ...move.task, assigneeIds: [] }, ...unassigned.items] };
    }
  }
  return { ...tray, unassigned, overdue };
}

// ─── Toast text ─────────────────────────────────────────────────────────

export type ReassignToastContext = {
  taskLabel: string;
  fromName: string | null;
  toName: string | null;
  toDay: string | null;
  /** Other assignees of the task (besides the source and the target), for D7. */
  otherAssigneeNames: string[];
};

/** Title + description of the success toast (no long dashes). */
export function reassignToastText(res: Pick<ReassignResponse, 'result' | 'reassignment' | 'changed' | 'addedToTeam' | 'loggedStays' | 'warnings'>, ctx: ReassignToastContext): { title: string; description: string } {
  const notes: string[] = [];
  let title: string;
  if (res.result === 'pending') {
    const approver = res.reassignment.approver?.name;
    title = `Approval requested: ${ctx.taskLabel} to ${ctx.toName ?? 'the new person'}`;
    notes.push(
      approver
        ? `The task stays with ${ctx.fromName ?? 'the current person'} until ${approver} approves.`
        : `The task stays with ${ctx.fromName ?? 'the current person'} until an Admin approves.`,
    );
  } else if (ctx.toName == null) {
    title = ctx.fromName ? `${ctx.taskLabel} unassigned from ${ctx.fromName}` : `${ctx.taskLabel} unassigned`;
  } else if (ctx.fromName == null) {
    title = `${ctx.taskLabel} assigned to ${ctx.toName}${res.changed.dates && ctx.toDay ? `, ${dayLabel(ctx.toDay)}` : ''}`;
  } else if (!res.changed.assignee && res.changed.dates && ctx.toDay) {
    title = `${ctx.taskLabel} moved to ${dayLabel(ctx.toDay)}`;
  } else {
    title = `${ctx.taskLabel} moved to ${ctx.toName}${res.changed.dates && ctx.toDay ? `, ${dayLabel(ctx.toDay)}` : ''}`;
  }
  if (res.result === 'applied' && res.changed.dates && ctx.otherAssigneeNames.length > 0) {
    notes.push(`The new dates also move the share of ${ctx.otherAssigneeNames.join(', ')}.`);
  }
  if (res.result === 'applied' && res.addedToTeam && ctx.toName) {
    notes.push(`${ctx.toName} was added to the project team.`);
  }
  notes.push(...outcomeNotes(res, ctx.fromName));
  return { title, description: notes.join(' ') };
}

/** ⏱ logged hours that stay with A, and the dependency warnings. */
function outcomeNotes(res: Pick<ReassignResponse, 'loggedStays' | 'warnings'>, fromName: string | null): string[] {
  const notes: string[] = [];
  if (res.loggedStays) {
    const who = res.loggedStays.name || fromName || 'the previous person';
    notes.push(
      res.loggedStays.hours != null
        ? `⏱ ${round2(res.loggedStays.hours)}h already logged stay with ${who}.`
        : `⏱ Hours already logged stay with ${who}.`,
    );
  }
  for (const w of res.warnings) notes.push(w.message.endsWith('.') ? w.message : `${w.message}.`);
  return notes;
}

/** The approver's toast after Approve (the response carries the same outcome fields as a move). */
export function approveToastText(
  res: Pick<ReassignResponse, 'loggedStays' | 'warnings' | 'addedToTeam'>,
  r: { task: { code: string | null; name: string }; from: { name: string } | null; to: { name: string } | null },
): { title: string; description: string } {
  const label = r.task.code ?? r.task.name;
  const notes: string[] = [];
  if (res.addedToTeam && r.to) notes.push(`${r.to.name} was added to the project team.`);
  notes.push(...outcomeNotes(res, r.from?.name ?? null));
  return { title: `Approved: ${label} moves to ${r.to?.name ?? 'the new person'}`, description: notes.join(' ') };
}

/** Which write failed: the same server code can mean different things (a 403 on undo is about the undo). */
export type ReassignErrorContext = 'move' | 'approve' | 'reject' | 'undo';

/**
 * The key an error is worded by.
 *  - A permission 403 keeps the API's convention, `code: PERMISSION_DENIED`
 *    with `details.reason` (REASSIGN_NOT_ALLOWED, ASSIGNEE_NOT_ON_TEAM). On
 *    undo it is UNDO_NOT_ALLOWED: not the actor or an Admin, or the actor
 *    lost the right to move the task.
 *  - `UNDO_STALE` with `details.reason`: UNDO_EXPIRED (after 15 minutes),
 *    UNDO_NOT_ON_TEAM (the person would get the task back but is no longer
 *    on the project team).
 *  - `REASSIGN_INVALID_DAY` with `details.reason`: MOVE_TOO_FAR (more than
 *    93 days), NOT_A_TASK_DAY (the source day is outside the task's dates).
 *    Without a reason it stays "Not a working day".
 *  - Everything else is the envelope's `error.code` (e.g.
 *    REASSIGN_REQUESTER_NOT_ALLOWED on approve).
 */
export function reassignErrorKey(code: string | null, details: unknown, context: ReassignErrorContext = 'move'): string | null {
  const raw = details && typeof details === 'object' ? (details as Record<string, unknown>).reason : undefined;
  const reason = typeof raw === 'string' && raw ? raw : null;
  if (code === 'PERMISSION_DENIED') {
    if (context === 'undo' && (reason == null || reason === 'REASSIGN_NOT_ALLOWED')) return 'UNDO_NOT_ALLOWED';
    return reason ?? code;
  }
  if (code === 'UNDO_STALE') {
    if (reason === 'UNDO_EXPIRED') return 'UNDO_EXPIRED';
    if (reason === 'NOT_ON_TEAM') return 'UNDO_NOT_ON_TEAM';
    return code;
  }
  if (code === 'REASSIGN_INVALID_DAY') {
    if (reason === 'MOVE_TOO_FAR') return 'MOVE_TOO_FAR';
    if (reason === 'NOT_A_TASK_DAY') return 'NOT_A_TASK_DAY';
    return code;
  }
  return code;
}

/** Clear words for a reassign / approve / reject / undo error key (see reassignErrorKey); null = the generic error. */
export function reassignErrorText(key: string | null): { title: string; description: string } | null {
  switch (key) {
    case 'ASSIGNEE_NOT_ON_TEAM':
      return { title: 'Not on the project team', description: 'Only the project leader or an Admin can give the task to someone outside the project team.' };
    case 'REASSIGN_NOT_ALLOWED':
      return { title: 'You cannot move this task', description: 'Only an Admin, the project leader or the person\'s manager can move it.' };
    case 'UNDO_NOT_ALLOWED':
      return { title: 'You cannot undo this move', description: 'Only the person who made the move, or an Admin, can undo it, and only while they are still allowed to move the task.' };
    case 'REASSIGN_REQUESTER_NOT_ALLOWED':
      return { title: 'The request was closed', description: 'The person who asked for this move is no longer allowed to move this task, so it was not applied. They were told. The list was refreshed.' };
    case 'SERVICE_NOT_PROVIDED':
      return { title: 'Does not provide this service', description: 'This person has none of the qualifications the task\'s service requires.' };
    case 'REASSIGN_INVALID_DAY':
      return { title: 'Not a working day', description: 'Drop the task on a working day.' };
    case 'MOVE_TOO_FAR':
      return { title: 'Too far to move', description: 'A task can move at most 93 days at a time. Drop it on a closer day.' };
    case 'NOT_A_TASK_DAY':
      return { title: 'The task is not on that day anymore', description: 'Its dates changed since the board was loaded. The board was refreshed. Drag it again from one of its days.' };
    case 'UNDO_NOT_ON_TEAM':
      return { title: 'Cannot undo', description: 'The person would get the task back, but they are no longer on the project team.' };
    case 'REASSIGN_STALE':
      return { title: 'The task changed in the meantime', description: 'Someone else moved or assigned it. The board and the tray were refreshed. Try again if it is still needed.' };
    case 'REASSIGN_PENDING':
      return { title: 'Already waiting for approval', description: 'This task has a move waiting for approval. Decide or cancel that one first.' };
    case 'REASSIGN_NOT_PENDING':
      return { title: 'Already decided', description: 'This request was already approved, rejected or cancelled. The list was refreshed.' };
    case 'UNDO_EXPIRED':
      return { title: 'Too late to undo', description: 'The 15 minutes to undo this move have passed.' };
    case 'UNDO_STALE':
      return { title: 'Cannot undo', description: 'The task changed after the move, so it can no longer be undone. The board was refreshed.' };
    case 'REASSIGN_LIST_INVALID':
      return { title: 'Could not load the move requests', description: 'The request list was asked for with a filter the server does not accept.' };
    default:
      return null;
  }
}
