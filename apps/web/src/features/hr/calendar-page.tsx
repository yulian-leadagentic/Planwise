import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronLeft, ChevronRight, X, Trash2, Download, Calendar, Check, Clock } from 'lucide-react';
import { useState, useMemo } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { Modal } from '@/components/shared/modal';
import { usePermissions } from '@/hooks/use-permissions';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/shared/confirm-dialog';

// HR F2 (2026-10-19) — Calendar moved from Admin → HR per Yulian's
// reversal of §15 R2. The file lives at features/hr/calendar-page.tsx,
// the sibling of /hr/review and /hr/settings. BE endpoint stays at
// `/calendar/*` (unchanged), and the queryKey stays as
// `['admin', 'calendar']` so the shared cache with weekly-timesheet
// (which also reads calendar days to grey-out holidays) keeps hitting
// the same cache slot — no fetch duplication.

// HR Phase B1 (2026-10-15) — CalendarDayType enum remapped per spec §3.2.
// Keys here mirror the Prisma enum exactly (UPPERCASE). REGULAR is listed
// for completeness but rows never land as REGULAR in the DB (the engine
// defaults missing dates to REGULAR implicitly) — keeping a style for it
// avoids a visual regression if someone writes one by hand later.
const TYPE_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  HOLIDAY:     { bg: 'bg-red-100',    text: 'text-red-700',    dot: 'bg-red-500' },
  REST:        { bg: 'bg-amber-100',  text: 'text-amber-700',  dot: 'bg-amber-500' },
  HOLIDAY_EVE: { bg: 'bg-blue-100',   text: 'text-blue-700',   dot: 'bg-blue-500' },
  CHOL_HAMOED: { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
  REGULAR:     { bg: 'bg-slate-100',  text: 'text-slate-700',  dot: 'bg-slate-500' },
};

// §15 R2 (2026-10-18) — Hebrew labels per Yulian's spec, mirroring
// the HR engine's day-type names. The HR module reads the same
// CalendarDay table, so a Hebrew-first label here keeps the admin and
// HR surfaces talking about the same thing. REGULAR is listed only as
// a defensive styling fallback — the engine never materialises
// REGULAR rows (missing dates default to REGULAR implicitly).
const TYPE_LABEL: Record<string, string> = {
  HOLIDAY:     'חג',
  REST:        'יום מנוחה',
  HOLIDAY_EVE: 'ערב חג',
  CHOL_HAMOED: 'חוה״מ',
  REGULAR:     'רגיל',
};

// HR F3 (2026-10-19) — real Hebrew-calendar classification via @hebcal/core.
// Dynamic-imported so the ~500 KB library only loads when the HR Manager
// actually clicks "Import"; the module isn't needed on the normal
// Calendar page render. Returns three day types the HR engine knows
// about: HOLIDAY (full-day yom tov), HOLIDAY_EVE (erev), CHOL_HAMOED
// (intermediate days of Pesach / Sukkot). Minor fasts, Rosh Chodesh,
// special Shabbatot and Yom HaShoah are skipped — they are not non-
// working days under AMEC's practice.
type CalendarDayType = 'HOLIDAY' | 'HOLIDAY_EVE' | 'CHOL_HAMOED';

async function getIsraeliCalendar(
  year: number,
): Promise<Array<{ date: string; name: string; nameHe: string; type: CalendarDayType }>> {
  const { HebrewCalendar, flags } = await import('@hebcal/core');

  const events = HebrewCalendar.calendar({
    year,
    isHebrewYear: false,
    il: true, // Israeli schedule (single-day yom tov)
    sedrot: false,
    omer: false,
    molad: false,
    yomKippurKatan: false,
    noHolidays: false,
    noMinorFast: true,
    noModern: false, // include Yom HaAtzma'ut + Yom HaZikaron
    noRoshChodesh: true,
    noSpecialShabbat: true,
  });

  const out: Array<{ date: string; name: string; nameHe: string; type: CalendarDayType }> = [];
  const seen = new Set<string>();

  for (const ev of events) {
    const greg = ev.getDate().greg();
    const dateStr = `${greg.getFullYear()}-${String(greg.getMonth() + 1).padStart(2, '0')}-${String(greg.getDate()).padStart(2, '0')}`;
    const nameEn = ev.render('en');
    let nameHe: string;
    try {
      nameHe = ev.render('he');
    } catch {
      nameHe = nameEn;
    }
    const mask = ev.getFlags();

    // Pre-filter false positives: Hebcal attaches EREV to minor-holiday
    // and major-fast events (Erev Purim, Erev Tish'a B'Av, Chanukah: 1
    // Candle). None of those are non-working days under AMEC's practice,
    // so we drop them BEFORE the EREV→HOLIDAY_EVE mapping below. The
    // only EREV we want to keep is the one tied to a true yom tov
    // (Erev Pesach / Shavuot / Rosh Hashana / Yom Kippur / Sukkot).
    if (mask & flags.MINOR_HOLIDAY) continue; // Purim, Chanukah, Lag BaOmer, etc.
    if (mask & flags.MAJOR_FAST && !(mask & flags.CHAG)) continue; // Tish'a B'Av + eve; Yom Kippur kept via CHAG

    // Classification order matters:
    // 1. CHOL_HAMOED beats EREV/CHAG for a day flagged both ways
    //    (Hoshana Rabba is CHOL_HAMOED, keep it as CHOL_HAMOED).
    // 2. EREV beats CHAG so "Erev Pesach" lands as HOLIDAY_EVE even
    //    when its parent Pesach event's mask carries CHAG.
    // 3. CHAG → HOLIDAY (full-day yom tov).
    // 4. MODERN_HOLIDAY → by name: Yom HaAtzma'ut = HOLIDAY, Yom
    //    HaZikaron = HOLIDAY_EVE (half-day in Israeli practice).
    //    Yom HaShoah is NOT a non-working day — skipped.
    let type: CalendarDayType | null = null;
    if (mask & flags.CHOL_HAMOED) type = 'CHOL_HAMOED';
    else if (mask & flags.EREV) type = 'HOLIDAY_EVE';
    else if (mask & flags.CHAG) type = 'HOLIDAY';
    else if (mask & flags.MODERN_HOLIDAY) {
      if (/Yom HaAtzma/i.test(nameEn) || /עצמאות/.test(nameHe)) type = 'HOLIDAY';
      else if (/Yom HaZikaron/i.test(nameEn) || /זיכרון/.test(nameHe)) type = 'HOLIDAY_EVE';
    }

    if (!type) continue; // skip Yom HaShoah, special-shabbat leftovers, etc.

    // De-dupe by date: first classified entry wins. CHOL_HAMOED comes
    // from the HebrewCalendar before daily holiday titles when both are
    // present; keeping the first entry is the correct behavior.
    if (seen.has(dateStr)) continue;
    seen.add(dateStr);
    out.push({ date: dateStr, name: nameEn, nameHe, type });
  }

  return out;
}

function countMonthWorkingDays(year: number, month: number, holidays: Set<string>): number {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dow !== 5 && dow !== 6 && !holidays.has(dateStr)) count++;
  }
  return count;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Monday = 0, Sunday = 6 (ISO week)
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const days: Array<{ date: Date; inMonth: boolean }> = [];

  // Previous month padding
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    days.push({ date: d, inMonth: false });
  }

  // Current month
  for (let i = 1; i <= daysInMonth; i++) {
    days.push({ date: new Date(year, month, i), inMonth: true });
  }

  // Next month padding to fill 6 rows
  while (days.length < 42) {
    const d = new Date(year, month + 1, days.length - daysInMonth - startDow + 1);
    days.push({ date: d, inMonth: false });
  }

  return days;
}

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type CalendarViewMode = 'month' | 'year';

export function HrCalendarPage() {
  // HR F2 (2026-10-19) — edit gating. The page is reachable with
  // `hr:read` (sub-nav + RoutePermissionGuard), but Add / Import /
  // Delete / Set-working-hours only make sense for someone who can
  // mutate the catalog. HR Clerk (hr:read only) gets a read-only
  // calendar — same pattern as /hr/settings sections.
  const { can } = usePermissions();
  const canWrite = can('hr', 'write');

  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
  const today = new Date();
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('REST');

  const { data, isLoading } = useQuery({
    // Keep the ['admin', 'calendar'] queryKey — weekly-timesheet.tsx
    // reads the SAME cache slot to grey out holidays on the grid.
    // Renaming it to ['hr', 'calendar'] would fork the cache and
    // double-fetch; harmless but wasteful. The URL `/calendar` is
    // unchanged, so a shared key still points at the same data.
    queryKey: ['admin', 'calendar'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/calendar').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { date: string; name: string; type: string }) =>
      client.post('/calendar', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      notify.success('Day added to calendar', { code: 'CAL-CREATE-200' });
      setShowAddForm(false);
      setSelectedDate(null);
      setFormName('');
      setFormType('REST');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add calendar day'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; halfDayUntil?: string; type?: string; notes?: string }) =>
      client.patch(`/calendar/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      notify.success('Calendar day updated');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/calendar/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      notify.success('Day removed', { code: 'CAL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  // Build lookup: dateKey → calendar entries
  const calendarMap = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const day of (data ?? [])) {
      const key = day.date ? formatDateKey(new Date(day.date)) : '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(day);
    }
    return map;
  }, [data]);

  const monthDays = useMemo(() => getMonthDays(viewYear, viewMonth), [viewYear, viewMonth]);
  const monthName = new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const todayKey = formatDateKey(today);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  };

  const handleDateClick = (dateKey: string) => {
    // Read-only viewers never open the Add form — the empty-day cells
    // stay inert for them. Matches the pattern in /hr/settings.
    if (!canWrite) return;
    setSelectedDate(dateKey);
    setShowAddForm(true);
    setFormName('');
    setFormType('REST');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDate || !formName.trim()) return;
    createMutation.mutate({ date: selectedDate, name: formName.trim(), type: formType });
  };

  // Weekend detection (Fri=5, Sat=6 for Israel)
  const isWeekend = (d: Date) => d.getDay() === 5 || d.getDay() === 6;

  const [importYear, setImportYear] = useState(today.getFullYear());
  const [showImport, setShowImport] = useState(false);
  const [workingDayEdit, setWorkingDayEdit] = useState<{ id: number; name: string; hours: string } | null>(null);

  // Check which years have calendar days imported. HR F3: the Hebcal-based
  // importer now also lands HOLIDAY_EVE and CHOL_HAMOED rows, so the
  // "imported" chip can't be gated on HOLIDAY alone — count a year as
  // imported when ANY row for that year is one of the three types the
  // importer writes.
  const importedYears = useMemo(() => {
    const years = new Set<number>();
    for (const d of (data ?? [])) {
      if ((d.type === 'HOLIDAY' || d.type === 'HOLIDAY_EVE' || d.type === 'CHOL_HAMOED') && d.date) {
        const yr = new Date(d.date).getFullYear();
        years.add(yr);
      }
    }
    return years;
  }, [data]);

  const importHolidays = async (year: number) => {
    // HR F3 (2026-10-19) — hebcal-based classification. The importer now
    // posts the day's real type (HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED) so
    // the HR monthly engine credits the correct short-day hours. Still
    // idempotent: any date that already has ANY calendar row is skipped
    // (second-click = no-op).
    let events: Array<{ date: string; name: string; nameHe: string; type: CalendarDayType }>;
    try {
      events = await getIsraeliCalendar(year);
    } catch (err: any) {
      notify.apiError(err, 'Failed to load Hebrew calendar');
      return;
    }
    // Local-date keys match the Set in `holidayDates` below. UTC-based
    // keys would shift a day for negative-UTC users; the backend writes
    // the Date as plain Y-M-D so we compare on the same shape.
    const existingDates = new Set(
      (data ?? []).map((d: any) =>
        typeof d.date === 'string' ? d.date.split('T')[0] : formatDateKey(new Date(d.date)),
      ),
    );
    let added = 0;
    let skipped = 0;
    for (const ev of events) {
      if (existingDates.has(ev.date)) { skipped++; continue; }
      try {
        await client.post('/calendar', {
          date: ev.date,
          name: `${ev.nameHe} (${ev.name})`,
          type: ev.type,
        });
        added++;
      } catch { skipped++; }
    }
    queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
    if (added > 0) {
      notify.success(
        `יובאו ${added} ימי לוח ישראלי לשנת ${year}${skipped > 0 ? ` (${skipped} כבר קיימים)` : ''}`,
        { code: 'CAL-IMPORT-200' },
      );
    } else {
      notify.info(`כל ימי ${year} כבר קיימים`);
    }
    setShowImport(false);
  };

  const holidayDates = useMemo(() => {
    const set = new Set<string>();
    for (const d of (data ?? [])) {
      if (d.date) set.add(typeof d.date === 'string' ? d.date.split('T')[0] : formatDateKey(new Date(d.date)));
    }
    return set;
  }, [data]);

  const monthWorkingDays = countMonthWorkingDays(viewYear, viewMonth, holidayDates);

  // Year view data
  const yearMonths = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const wd = countMonthWorkingDays(viewYear, i, holidayDates);
      const daysInMonth = new Date(viewYear, i + 1, 0).getDate();
      const monthHolidays: any[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${viewYear}-${String(i + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const entries = calendarMap.get(dateStr);
        if (entries) monthHolidays.push(...entries.map((e: any) => ({ ...e, day: d })));
      }
      let weekendCount = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(viewYear, i, d).getDay();
        if (dow === 5 || dow === 6) weekendCount++;
      }
      return {
        index: i,
        name: new Date(viewYear, i).toLocaleDateString('en-US', { month: 'long' }),
        shortName: new Date(viewYear, i).toLocaleDateString('en-US', { month: 'short' }),
        total: daysInMonth,
        working: wd,
        holidays: monthHolidays.length,
        weekends: weekendCount,
        holidayList: monthHolidays,
      };
    });
  }, [viewYear, holidayDates, calendarMap]);

  const yearTotalWorking = yearMonths.reduce((s, m) => s + m.working, 0);
  const yearTotalHolidays = yearMonths.reduce((s, m) => s + m.holidays, 0);

  const handleSetWorkingDay = (entry: any) => {
    setWorkingDayEdit({ id: entry.id, name: entry.name, hours: entry.halfDayUntil || '4' });
  };

  const saveWorkingDay = () => {
    if (!workingDayEdit) return;
    updateMutation.mutate({ id: workingDayEdit.id, halfDayUntil: workingDayEdit.hours }, {
      onSuccess: () => setWorkingDayEdit(null),
    });
  };

  const clearWorkingDay = (entry: any) => {
    updateMutation.mutate({ id: entry.id, halfDayUntil: '' });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar Days"
        description="לוח שנה · Holidays, non-working days, and company days off"
      />

      {/* Controls bar: view toggle + import status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button onClick={() => setViewMode('month')}
              className={cn('px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
                viewMode === 'month' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
              Month
            </button>
            <button onClick={() => setViewMode('year')}
              className={cn('px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
                viewMode === 'year' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}>
              Year
            </button>
          </div>
        </div>

        {/* Import status + button — Import button is HR-write-gated so
            an HR Clerk sees the imported-years chip but no action. */}
        <div className="flex items-center gap-3">
          {importedYears.size > 0 && (
            <div className="flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              <span>Israeli Holidays imported for {Array.from(importedYears).sort().join(', ')}</span>
            </div>
          )}
          {canWrite && (
            <div className="flex items-center gap-1.5">
              <select value={importYear} onChange={(e) => setImportYear(Number(e.target.value))}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] text-slate-700 dark:text-slate-200">
                {[2025, 2026, 2027, 2028].map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <button onClick={() => importHolidays(importYear)}
                className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors',
                  importedYears.has(importYear)
                    ? 'border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    : 'bg-blue-600 text-white hover:bg-blue-700')}>
                <Download className="h-3.5 w-3.5" />
                {importedYears.has(importYear) ? `Re-import ${importYear}` : `Import ${importYear}`}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ═══ MONTH VIEW ═══ */}
      {viewMode === 'month' && (
        <>
          {/* Month navigation + working days count */}
          <div className="flex items-center justify-between">
            <button onClick={prevMonth} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Previous"><ChevronLeft className="h-5 w-5"  aria-hidden="true" /></button>
            <div className="text-center">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{monthName}</h2>
              <p className="text-[12px] text-slate-400 dark:text-slate-500">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{monthWorkingDays}</span> working days this month
              </p>
            </div>
            <button onClick={nextMonth} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Next"><ChevronRight className="h-5 w-5"  aria-hidden="true" /></button>
          </div>

          {/* Legend — §15 R2 Hebrew-first labels match the HR engine's
              day-type naming so the admin + HR surfaces agree. */}
          <div className="flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500" /> חג</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-amber-500" /> יום מנוחה</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500" /> ערב חג</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-purple-500" /> חוה״מ</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-200 dark:bg-slate-700" /> סופ״ש</div>
          </div>

          {/* Calendar Grid */}
          <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              {DAY_NAMES.map((day) => (
                <div key={day} className="px-2 py-2.5 text-center text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{day}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {monthDays.map(({ date, inMonth }, idx) => {
                const dateKey = formatDateKey(date);
                const entries = calendarMap.get(dateKey) ?? [];
                const isToday = dateKey === todayKey;
                const weekend = isWeekend(date);
                const hasEntries = entries.length > 0;
                const isSelected = selectedDate === dateKey;
                return (
                  <div key={idx} onClick={() => inMonth && handleDateClick(dateKey)}
                    className={cn('min-h-[90px] border-b border-r border-slate-100 dark:border-slate-800 px-1.5 py-1 transition-colors',
                      canWrite ? 'cursor-pointer' : 'cursor-default',
                      !inMonth && 'bg-slate-50 dark:bg-slate-800/50 opacity-40', inMonth && weekend && !hasEntries && 'bg-slate-50 dark:bg-slate-800/50',
                      inMonth && hasEntries && 'bg-red-50/30 dark:bg-red-900/10', isSelected && 'ring-2 ring-inset ring-blue-500 bg-blue-50/30 dark:bg-blue-900/20',
                      inMonth && !hasEntries && !weekend && canWrite && 'hover:bg-blue-50/20 dark:hover:bg-blue-900/10')}>
                    <div className="flex items-center justify-between">
                      <span className={cn('text-[13px] font-medium', !inMonth ? 'text-slate-300 dark:text-slate-600' : isToday ? 'text-white bg-blue-600 rounded-full w-7 h-7 flex items-center justify-center' : 'text-slate-700 dark:text-slate-200', weekend && inMonth && !isToday && 'text-slate-400 dark:text-slate-500')}>
                        {date.getDate()}
                      </span>
                      {weekend && inMonth && <span className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">Weekend</span>}
                    </div>
                    {entries.map((entry: any) => {
                      const style = TYPE_STYLES[entry.type] ?? TYPE_STYLES.CHOL_HAMOED;
                      const isHoliday = entry.type === 'HOLIDAY';
                      const hasWorkingHours = isHoliday && entry.halfDayUntil;
                      return (
                        <div key={entry.id} className={cn('mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium flex items-center justify-between group', style.bg, style.text)} onClick={(e) => e.stopPropagation()}>
                          <span className="truncate">
                            {entry.name}
                            {hasWorkingHours && <span className="ml-1 text-blue-600 dark:text-blue-400 font-bold">+{entry.halfDayUntil}h</span>}
                          </span>
                          {canWrite && (
                            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                              {isHoliday ? (
                                hasWorkingHours ? (
                                  <button onClick={() => clearWorkingDay(entry)} title="Remove working hours"
                                    className="h-4 w-4 flex items-center justify-center rounded hover:bg-white dark:hover:bg-slate-900/50">
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                ) : (
                                  <button onClick={() => handleSetWorkingDay(entry)} title="Set as working day"
                                    className="h-4 flex items-center gap-0.5 rounded px-1 hover:bg-white dark:hover:bg-slate-900/50 text-[9px] font-bold text-blue-700 dark:text-blue-300">
                                    <Clock className="h-2.5 w-2.5" />Work
                                  </button>
                                )
                              ) : (
                                <button onClick={async () => { if (await confirm(`Remove "${entry.name}"?`)) deleteMutation.mutate(entry.id); }}
                                  className="h-4 w-4 flex items-center justify-center rounded hover:bg-white dark:hover:bg-slate-900/50">
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ═══ YEAR VIEW ═══ */}
      {viewMode === 'year' && (
        <>
          <div className="flex items-center justify-between">
            <button onClick={() => setViewYear(viewYear - 1)} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronLeft className="h-5 w-5" /></button>
            <div className="text-center">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{viewYear}</h2>
              <p className="text-[12px] text-slate-400 dark:text-slate-500">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{yearTotalWorking}</span> working days
                {yearTotalHolidays > 0 && <> · <span className="text-red-500">{yearTotalHolidays} holidays</span></>}
              </p>
            </div>
            <button onClick={() => setViewYear(viewYear + 1)} className="rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800"><ChevronRight className="h-5 w-5" /></button>
          </div>

          <div className="grid grid-cols-3 lg:grid-cols-4 gap-3">
            {yearMonths.map((m) => {
              const isCurrent = viewYear === today.getFullYear() && m.index === today.getMonth();
              return (
                <div key={m.index}
                  className={cn('rounded-[14px] border bg-white dark:bg-slate-900 p-4 cursor-pointer hover:border-blue-300 dark:hover:border-blue-500 transition-colors',
                    isCurrent ? 'border-blue-300 dark:border-blue-500 ring-2 ring-blue-100 dark:ring-blue-900/40' : 'border-slate-200 dark:border-slate-700')}
                  onClick={() => { setViewMonth(m.index); setViewMode('month'); }}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className={cn('text-sm font-semibold', isCurrent ? 'text-blue-600 dark:text-blue-400' : 'text-slate-900 dark:text-slate-100')}>{m.name}</h3>
                    {m.holidays > 0 && (
                      <span className="text-[10px] font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-1.5 py-0.5">{m.holidays}</span>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-2 text-center mb-3">
                    <div>
                      <p className="text-lg font-bold text-slate-700 dark:text-slate-200">{m.working}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">Working</p>
                    </div>
                    <div>
                      <p className={cn('text-lg font-bold', m.holidays > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-300 dark:text-slate-600')}>{m.holidays}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">Holidays</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-slate-400 dark:text-slate-500">{m.total}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">Total</p>
                    </div>
                  </div>

                  {/* Working days progress bar */}
                  <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(m.working / m.total) * 100}%` }} />
                  </div>

                  {/* Holiday names */}
                  {m.holidayList.length > 0 && (
                    <div className="space-y-0.5">
                      {m.holidayList.slice(0, 3).map((h: any, i: number) => {
                        const style = TYPE_STYLES[h.type] ?? TYPE_STYLES.CHOL_HAMOED;
                        return (
                          <div key={i} className="flex items-center gap-1.5">
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', style.dot)} />
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{h.day} - {h.name}</span>
                          </div>
                        );
                      })}
                      {m.holidayList.length > 3 && (
                        <span className="text-[10px] text-slate-400 dark:text-slate-500">+{m.holidayList.length - 3} more</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Year summary table */}
          <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="bg-slate-50 dark:bg-slate-800/50 px-5 py-3 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">{viewYear} Summary</h3>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#FAFBFC] dark:bg-slate-800/50 text-[11px] uppercase text-slate-400 dark:text-slate-500 tracking-[0.05em]">
                  <th className="px-5 py-2.5 text-left font-semibold">Month</th>
                  <th className="px-5 py-2.5 text-center font-semibold">Working</th>
                  <th className="px-5 py-2.5 text-center font-semibold">Holidays</th>
                  <th className="px-5 py-2.5 text-center font-semibold">Weekends</th>
                  <th className="px-5 py-2.5 text-center font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {yearMonths.map((m) => {
                  const isCurrent = viewYear === today.getFullYear() && m.index === today.getMonth();
                  return (
                    <tr key={m.index} className={cn('border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer', isCurrent && 'bg-blue-50/30 dark:bg-blue-900/20')}
                      onClick={() => { setViewMonth(m.index); setViewMode('month'); }}>
                      <td className={cn('px-5 py-2.5 font-medium', isCurrent ? 'text-blue-600 dark:text-blue-400' : 'text-slate-700 dark:text-slate-200')}>{m.name}</td>
                      <td className="px-5 py-2.5 text-center font-mono font-semibold text-slate-700 dark:text-slate-200">{m.working}</td>
                      <td className="px-5 py-2.5 text-center font-mono">
                        {m.holidays > 0 ? <span className="font-semibold text-red-600 dark:text-red-400">{m.holidays}</span> : <span className="text-slate-300 dark:text-slate-600">0</span>}
                      </td>
                      <td className="px-5 py-2.5 text-center font-mono text-slate-400 dark:text-slate-500">{m.weekends}</td>
                      <td className="px-5 py-2.5 text-center font-mono text-slate-400 dark:text-slate-500">{m.total}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 font-bold">
                  <td className="px-5 py-2.5 text-slate-900 dark:text-slate-100">Total</td>
                  <td className="px-5 py-2.5 text-center font-mono text-slate-900 dark:text-slate-100">{yearTotalWorking}</td>
                  <td className="px-5 py-2.5 text-center font-mono text-red-600 dark:text-red-400">{yearTotalHolidays}</td>
                  <td className="px-5 py-2.5 text-center font-mono text-slate-400 dark:text-slate-500">{yearMonths.reduce((s, m) => s + m.weekends, 0)}</td>
                  <td className="px-5 py-2.5 text-center font-mono text-slate-400 dark:text-slate-500">{yearMonths.reduce((s, m) => s + m.total, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add Day Form (appears when a date is clicked) — only reachable
          via handleDateClick, which is itself gated on canWrite. */}
      {showAddForm && selectedDate && canWrite && (
        <div className="rounded-[14px] border border-blue-200 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-900/20 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Add Non-Working Day — {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </h3>
            <button onClick={() => { setShowAddForm(false); setSelectedDate(null); }} className="rounded-md p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 dark:text-slate-500">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Team Building Day, Rosh Hashana"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none" autoFocus />
            </div>
            <div className="w-48">
              <label className="block text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Type</label>
              {/* §15 R2 (2026-10-18) — 4 user-pickable CalendarDayType
                  values. REGULAR is excluded on purpose: the HR
                  engine implicitly defaults missing dates to REGULAR,
                  so a materialised REGULAR row would be a lie. The HR
                  monthly engine depends on these exact enum values. */}
              <select value={formType} onChange={(e) => setFormType(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none">
                <option value="HOLIDAY">חג · Holiday</option>
                <option value="HOLIDAY_EVE">ערב חג · Holiday eve</option>
                <option value="CHOL_HAMOED">חוה״מ · Chol-hamoed</option>
                <option value="REST">יום מנוחה · Rest / Company day off</option>
              </select>
            </div>
            <button type="submit" disabled={!formName.trim() || createMutation.isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {createMutation.isPending ? 'Adding...' : 'Add Day'}
            </button>
          </form>
        </div>
      )}

      {/* Working hours modal for holidays — People UX M1 on shared Modal. */}
      {workingDayEdit && (
        <Modal
          open
          onClose={() => setWorkingDayEdit(null)}
          title="Set Working Hours on Holiday"
          description={
            <>
              Mark <strong>{workingDayEdit.name}</strong> as a working day with reduced hours. It will still display as a holiday.
            </>
          }
          widthClass="w-full max-w-sm"
          footer={
            <>
              <button
                type="button"
                onClick={() => setWorkingDayEdit(null)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveWorkingDay}
                disabled={updateMutation.isPending}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {updateMutation.isPending ? 'Saving...' : 'Set Working Hours'}
              </button>
            </>
          }
        >
          <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Working Hours</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max="12"
              step="0.5"
              value={workingDayEdit.hours}
              onChange={(e) => setWorkingDayEdit({ ...workingDayEdit, hours: e.target.value })}
              className="w-20 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <span className="text-[13px] text-slate-500 dark:text-slate-400">hours (standard day = 8h)</span>
          </div>
        </Modal>
      )}

      {/* All Non-Working Days list — read-only viewers see the list but
          no row-level edit / delete controls. */}
      {(data ?? []).length > 0 && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-3">All Non-Working Days</h3>
          <div className="space-y-1.5">
            {(data as any[]).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((d: any) => {
              const style = TYPE_STYLES[d.type] ?? TYPE_STYLES.CHOL_HAMOED;
              const isPast = new Date(d.date) < today;
              const isHoliday = d.type === 'HOLIDAY';
              const hasWorkingHours = isHoliday && d.halfDayUntil;
              return (
                <div key={d.id} className={cn('flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50', isPast && 'opacity-50')}>
                  <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', style.dot)} />
                  <span className="text-[13px] font-medium text-slate-700 dark:text-slate-200 w-32">{new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s+/g, '-')}</span>
                  <span className="text-[13px] text-slate-800 dark:text-slate-100 flex-1">
                    {d.name}
                    {hasWorkingHours && (
                      <span className="ml-2 text-[11px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded px-1.5 py-0.5">+{d.halfDayUntil}h working</span>
                    )}
                  </span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', style.bg, style.text)}>{TYPE_LABEL[d.type] ?? d.type}</span>
                  {canWrite && (isHoliday ? (
                    <button onClick={() => handleSetWorkingDay(d)}
                      className="rounded px-2 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                      title="Set working hours">
                      <Clock className="h-3.5 w-3.5 inline mr-1" />{hasWorkingHours ? 'Edit hours' : 'Set working'}
                    </button>
                  ) : (
                    <button onClick={async () => { if (await confirm(`Remove "${d.name}"?`)) deleteMutation.mutate(d.id); }}
                      className="rounded p-1 text-slate-300 dark:text-slate-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
