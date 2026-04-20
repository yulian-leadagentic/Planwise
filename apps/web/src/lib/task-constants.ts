/**
 * Shared task/zone visual constants. Previously duplicated across
 * execution-board, my-tasks-kanban, task-drawer, and planning-modal.
 */

export const STATUS_DOT: Record<string, string> = {
  not_started: 'bg-slate-400',
  in_progress: 'bg-blue-500',
  in_review: 'bg-violet-500',
  completed: 'bg-emerald-500',
  on_hold: 'bg-amber-500',
  cancelled: 'bg-red-500',
};

export const STATUS_PILL: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700',
  completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-red-100 text-red-700',
};

export const STATUS_LABEL: Record<string, string> = {
  not_started: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Done',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
};

export const PRIORITY_PILL: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
};

export const ZONE_BORDER_COLORS: Record<string, string> = {
  site: 'border-l-indigo-400',
  building: 'border-l-amber-500',
  level: 'border-l-teal-400',
  zone: 'border-l-amber-400',
  area: 'border-l-purple-400',
  floor: 'border-l-blue-400',
  section: 'border-l-teal-400',
  wing: 'border-l-pink-400',
};

export function formatShortDate(iso: string): string {
  const d = new Date(iso.split('T')[0]);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
