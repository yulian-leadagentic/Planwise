export type HealthLevel = 'critical' | 'warning' | 'ok';

export interface TaskHealthInput {
  status: string;
  endDate?: string | null;
  budgetHours?: number | null;
  loggedMinutes?: number | null;
  lastActivityDate?: string | null;
  completionPct?: number | null;
}

export interface TaskHealth {
  level: HealthLevel;
  reasons: string[];
  computedPct: number;
  loggedHours: number;
  estimatedHours: number;
  isOverdue: boolean;
  isStale: boolean;
}

const DONE_STATUSES = new Set(['completed', 'cancelled']);
const MS_PER_DAY = 86400000;

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export function getTaskHealth(task: TaskHealthInput): TaskHealth {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const estimatedHours = Number(task.budgetHours) || 0;
  const loggedMinutes = Number(task.loggedMinutes) || 0;
  const loggedHours = Math.round((loggedMinutes / 60) * 10) / 10;
  const computedPct = estimatedHours > 0
    ? Math.min(100, Math.round((loggedHours / estimatedHours) * 100))
    : (task.completionPct ?? 0);

  const isDone = DONE_STATUSES.has(task.status);
  const reasons: string[] = [];
  let level: HealthLevel = 'ok';
  let isOverdue = false;
  let isStale = false;

  if (isDone) {
    return { level: 'ok', reasons: [], computedPct: isDone ? 100 : computedPct, loggedHours, estimatedHours, isOverdue: false, isStale: false };
  }

  const dueDate = task.endDate ? new Date(task.endDate.split('T')[0]) : null;

  // Rule 1: Overdue — due date passed
  if (dueDate && dueDate < today) {
    isOverdue = true;
    const daysLate = daysBetween(dueDate, today);
    reasons.push(`${daysLate}d overdue`);
    level = 'critical';
  }

  // Rule 2: Due soon but not started
  if (dueDate && !isOverdue) {
    const daysLeft = daysBetween(today, dueDate);
    if (daysLeft <= 3 && task.status === 'not_started') {
      reasons.push(`Due in ${daysLeft}d, not started`);
      level = 'critical';
    }
  }

  // Rule 3: Behind schedule — low completion relative to time remaining
  if (dueDate && !isOverdue && estimatedHours > 0) {
    const daysLeft = daysBetween(today, dueDate);
    if (daysLeft <= 1 && computedPct < 80) {
      reasons.push(`Due tomorrow, only ${computedPct}% done`);
      if (level !== 'critical') level = 'critical';
    } else if (daysLeft <= 3 && computedPct < 50) {
      reasons.push(`Due in ${daysLeft}d, only ${computedPct}% done`);
      if (level === 'ok') level = 'warning';
    }
  }

  // Rule 4: Stale — in progress but no time logged for 5+ days
  if (task.status === 'in_progress' || task.status === 'in_review') {
    if (task.lastActivityDate) {
      const lastDate = new Date(task.lastActivityDate);
      const daysSince = daysBetween(lastDate, today);
      if (daysSince >= 5) {
        isStale = true;
        reasons.push(`No activity for ${daysSince}d`);
        if (level === 'ok') level = 'warning';
      }
    } else if (loggedMinutes === 0) {
      isStale = true;
      const label = task.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      reasons.push(`${label}, no hours logged`);
      if (level === 'ok') level = 'warning';
    }
  }

  // Rule 5: Over budget — more hours logged than estimated
  if (estimatedHours > 0 && loggedHours > estimatedHours) {
    const overHours = Math.round((loggedHours - estimatedHours) * 10) / 10;
    const pctOver = Math.round(((loggedHours - estimatedHours) / estimatedHours) * 100);
    reasons.push(`Over budget by ${overHours}h (+${pctOver}%)`);
    if (pctOver >= 50) {
      // Severely over — promote to critical
      level = 'critical';
    } else if (level === 'ok') {
      level = 'warning';
    }
  }

  // Rule 6: Effectively done but status still "in_progress"
  if (task.status === 'in_progress' && estimatedHours > 0 && loggedHours >= estimatedHours) {
    reasons.push('Hours complete — move to Review/Done');
    if (level === 'ok') level = 'warning';
  }

  return { level, reasons, computedPct, loggedHours, estimatedHours, isOverdue, isStale };
}

export function aggregateHealth(items: TaskHealth[]): { critical: number; warning: number; ok: number } {
  let critical = 0;
  let warning = 0;
  let ok = 0;
  for (const h of items) {
    if (h.level === 'critical') critical++;
    else if (h.level === 'warning') warning++;
    else ok++;
  }
  return { critical, warning, ok };
}
