/* Weekly timesheet › Quick task: create a task in the project's first
   zone and assign it to the current user, so the time entry can be
   logged on it right away.

   QA6 security review (2026-11-25): the self-assign step used to swallow
   its error. Since QA6 an assignment no longer brings anyone into a
   project, so the server can refuse it (403 ASSIGNEE_NOT_ON_TEAM when
   the user is not on the project's Team), and the user was left with a
   silent, unassigned task and a time entry on it. Now a refused
   assignment removes the new task again (or says plainly that it could
   not) and hands the server's error back, so the caller shows it with
   `notify.apiError` and logs nothing. The assignment rule itself is not
   changed here.

   Pure over a minimal HTTP client so it is unit-tested on its own. */

export interface QuickTaskHttp {
  get(url: string): Promise<{ data: unknown }>;
  post(url: string, body?: unknown): Promise<{ data: unknown }>;
  delete(url: string): Promise<unknown>;
}

/** The created task as the API returned it. */
export interface QuickTask {
  id: number;
  [key: string]: unknown;
}

export type QuickTaskResult =
  | { ok: true; task: QuickTask }
  | { ok: false; reason: 'NO_ZONE' | 'TASK_NOT_CREATED' }
  | {
      ok: false;
      reason: 'ASSIGN_FAILED';
      /** The server's refusal (axios error), for `notify.apiError`. */
      error: unknown;
      task: QuickTask;
      /** The new task was deleted again; false = it still exists, unassigned. */
      taskRemoved: boolean;
    };

/** `{ data: { data: X } }` or `{ data: X }` → X. */
function unwrap(res: { data: unknown }): Record<string, unknown> | null {
  const body = res?.data as { data?: unknown } | null | undefined;
  return ((body?.data ?? body) ?? null) as Record<string, unknown> | null;
}

export async function createQuickTaskForMe(
  http: QuickTaskHttp,
  args: { projectId: number | string; name: string; userId: number; code?: string },
): Promise<QuickTaskResult> {
  // 1. The project's first zone.
  const pd = unwrap(await http.get(`/projects/${args.projectId}/planning-data`));
  const firstZoneId = (pd?.zones as Array<{ id?: number }> | undefined)?.[0]?.id;
  if (!firstZoneId) return { ok: false, reason: 'NO_ZONE' };

  // 2. The task.
  const task = unwrap(
    await http.post('/tasks', {
      zoneId: firstZoneId,
      code: args.code ?? `QT-${Date.now().toString(36).toUpperCase()}`,
      name: args.name,
    }),
  );
  if (!task || typeof task.id !== 'number') return { ok: false, reason: 'TASK_NOT_CREATED' };

  // 3. Assign the current user. A refusal is not swallowed: take the new
  //    task out again so no unassigned task is left behind.
  try {
    await http.post(`/tasks/${task.id}/assignees`, { userId: args.userId });
  } catch (error) {
    let taskRemoved = false;
    try {
      await http.delete(`/tasks/${task.id}`);
      taskRemoved = true;
    } catch {
      taskRemoved = false;
    }
    return { ok: false, reason: 'ASSIGN_FAILED', error, task: task as QuickTask, taskRemoved };
  }
  return { ok: true, task: task as QuickTask };
}
