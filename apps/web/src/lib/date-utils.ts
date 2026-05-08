import {
  format,
  formatDistanceToNow,
  parseISO,
  isToday,
  isYesterday,
  startOfWeek,
  endOfWeek,
  addDays,
  differenceInMinutes,
  isSameDay,
} from 'date-fns';

// All app-wide date display goes through these helpers. Canonical format
// is `DD-MMM-YYYY` (e.g. 07-May-2026) — dash-separated, three-letter
// month, four-digit year. Short variants drop the year. Use these
// instead of `toLocaleDateString` so the format stays consistent across
// the app.
export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd-MMM-yyyy');
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd-MMM-yyyy HH:mm');
}

export function formatTime(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'HH:mm');
}

export function formatRelative(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  if (isToday(d)) return `Today at ${format(d, 'HH:mm')}`;
  if (isYesterday(d)) return `Yesterday at ${format(d, 'HH:mm')}`;
  return formatDistanceToNow(d, { addSuffix: true });
}

/** Short display when year is implied (e.g. cards, kanban). `07-May`. */
export function formatShortDate(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd-MMM');
}

export function formatDayHeader(date: string | Date): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'EEE, dd-MMM');
}

export function getWeekRange(date: Date): { start: Date; end: Date } {
  return {
    start: startOfWeek(date, { weekStartsOn: 1 }),
    end: endOfWeek(date, { weekStartsOn: 1 }),
  };
}

export function getWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function minutesBetween(start: string | Date, end: string | Date): number {
  const s = typeof start === 'string' ? parseISO(start) : start;
  const e = typeof end === 'string' ? parseISO(end) : end;
  return differenceInMinutes(e, s);
}

/**
 * Format a number of days as a human-friendly duration. Picks the
 * largest sensible unit so the number stays small:
 *   <30 days  → `Nd`           (e.g. "12d")
 *   <12 mo    → `Nmo`          (e.g. "5mo")
 *   <2 yr     → `Ny Nmo`       (e.g. "1y 4mo")
 *   ≥2 yr     → `Ny`           (e.g. "3y")
 *
 * Uses 30 days/month and 365 days/year as fixed approximations — more
 * than precise enough for "X left" badges on planning headers and not
 * worth importing date-fns variants for.
 */
export function formatDuration(days: number): string {
  const d = Math.max(0, Math.round(Number(days) || 0));
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  const years = Math.floor(d / 365);
  const remMonths = Math.round((d - years * 365) / 30);
  if (years < 2 && remMonths > 0) return `${years}y ${remMonths}mo`;
  return `${years}y`;
}

export { isToday, isSameDay, parseISO, addDays, startOfWeek, format };
