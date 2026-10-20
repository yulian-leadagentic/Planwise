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
  // HR G2 (2026-10-19) — per-type default working hours. HOLIDAY /
  // REST = 0h (person is off), HOLIDAY_EVE / CHOL_HAMOED = 5h
  // (historical short-day). The Add form seeds from this; the server
  // also falls back to the same values if the FE ever omits the key.
  const WORKING_HOURS_DEFAULT_BY_TYPE: Record<string, number> = {
    HOLIDAY: 0,
    HOLIDAY_EVE: 5,
    CHOL_HAMOED: 5,
    REST: 0,
  };
  const [formWorkingHours, setFormWorkingHours] = useState<string>(
    String(WORKING_HOURS_DEFAULT_BY_TYPE.REST),
  );

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
    // HR G2 (2026-10-19) — Create payload carries workingHours. Server
    // falls back to the type default (HOLIDAY_EVE / CHOL_HAMOED = 5,
    // HOLIDAY / REST = 0) if the key is omitted.
    mutationFn: (payload: {
      date: string;
      name: string;
      type: string;
      workingHours?: number | null;
    }) => client.post('/calendar', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      notify.success('Day added to calendar', { code: 'CAL-CREATE-200' });
      setShowAddForm(false);
      setSelectedDate(null);
      setFormName('');
      setFormType('REST');
      setFormWorkingHours(String(WORKING_HOURS_DEFAULT_BY_TYPE.REST));
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add calendar day'),
  });

  const updateMutation = useMutation({
    // HR G2 (2026-10-19) — Patch payload carries workingHours. An
    // explicit null clears the row back to the type default; omitted
    // key preserves the stored value.
    mutationFn: ({
      id,
      ...payload
    }: {
      id: number;
      workingHours?: number | null;
      type?: string;
      notes?: string;
    }) => client.patch(`/calendar/${id}`, payload).then((r) => r.data),
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
    setFormWorkingHours(String(WORKING_HOURS_DEFAULT_BY_TYPE.REST));
  };

  const handleFormTypeChange = (newType: string) => {
    // HR G2 (2026-10-19) — flipping the day type re-seeds the working
    // hours field to that type's default so the operator doesn't have
    // to blank + retype. If they later edit the number by hand, their
    // value stays until they switch type again.
    setFormType(newType);
    setFormWorkingHours(String(WORKING_HOURS_DEFAULT_BY_TYPE[newType] ?? 0));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDate || !formName.trim()) return;
    // HR G2 (2026-10-19) — validate workingHours client-side; same
    // invariant as the server (0 ≤ v ≤ 24, 2-decimal cap). Empty →
    // omit the key (server falls back to the type default).
    const raw = formWorkingHours.trim();
    let workingHours: number | undefined;
    if (raw !== '') {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 24) {
        notify.error('Working hours must be between 0 and 24.', { code: 'CAL-WH-RANGE' });
        return;
      }
      workingHours = v;
    }
    createMutation.mutate({
      date: selectedDate,
      name: formName.trim(),
      type: formType,
      ...(workingHours !== undefined ? { workingHours } : {}),
    });
  };

  // Weekend detection (Fri=5, Sat=6 for Israel)
  const isWeekend = (d: Date) => d.getDay() === 5 || d.getDay() === 6;

  const [importYear, setImportYear] = useState(today.getFullYear());
  const [showImport, setShowImport] = useState(false);
  // HR G2 (2026-10-19) — modal now edits `workingHours` directly.
  // `hours` state key renamed to `workingHours` for clarity.
  const [workingDayEdit, setWorkingDayEdit] = useState<{
    id: number;
    name: string;
    type: string;
    workingHours: string;
  } | null>(null);

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
        // HR G2 (2026-10-19) — set workingHours per inferred type so
        // the row lands with a non-null value even on a brand-new DB
        // where the backfill never ran. The server would also fill
        // the same default; we send it explicitly so the intent is
        // obvious in request logs.
        await client.post('/calendar', {
          date: ev.date,
          name: `${ev.nameHe} (${ev.name})`,
          type: ev.type,
          workingHours: WORKING_HOURS_DEFAULT_BY_TYPE[ev.type] ?? 0,
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

  // HR Wave 3 A (2026-10-20) — list filters + nearest-upcoming sort for
  // the "All Non-Working Days" table at the bottom of the page. Yulian
  // asked for sort-by-nearest-upcoming + per-column filters (date range,
  // name search, type dropdown) because the list grew long enough that
  // scrolling to find a specific event was friction. Inline edit was
  // intentionally left as a separate follow-up — the "Edit hours" button
  // already opens the modal, which is enough for this wave.
  const [listNameFilter, setListNameFilter] = useState('');
  const [listTypeFilter, setListTypeFilter] = useState<string>('all');
  const [listDateFrom, setListDateFrom] = useState<string>('');
  const [listDateTo, setListDateTo] = useState<string>('');

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
    // HR G2 (2026-10-19) — pre-fill with the row's current
    // workingHours; fall back to the type default when the row still
    // has null (e.g. a stray REGULAR row written by hand).
    const current =
      entry.workingHours != null
        ? Number(entry.workingHours)
        : WORKING_HOURS_DEFAULT_BY_TYPE[entry.type] ?? 0;
    setWorkingDayEdit({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      workingHours: String(current),
    });
  };

  const saveWorkingDay = () => {
    if (!workingDayEdit) return;
    const v = Number(workingDayEdit.workingHours);
    if (!Number.isFinite(v) || v < 0 || v > 24) {
      notify.error('Working hours must be between 0 and 24.', { code: 'CAL-WH-RANGE' });
      return;
    }
    updateMutation.mutate(
      { id: workingDayEdit.id, workingHours: v },
      { onSuccess: () => setWorkingDayEdit(null) },
    );
  };

  const clearWorkingDay = (entry: any) => {
    // HR G2 (2026-10-19) — explicit null tells the BE to clear the
    // override. The row then shows the type default on next read.
    updateMutation.mutate({ id: entry.id, workingHours: null });
  };

  // HR G2 (2026-10-19) — tells us whether a row's workingHours differs
  // from the type default. Drives the "+Xh" badge on day cells (hidden
  // when the row already carries the standard value for its type).
  const isNonDefaultWorkingHours = (entry: any): boolean => {
    if (entry.workingHours == null) return false;
    const def = WORKING_HOURS_DEFAULT_BY_TYPE[entry.type] ?? 0;
    return Number(entry.workingHours) !== def;
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
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">{monthWorkingDays}</span> working days this month
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
                      // HR G2 (2026-10-19) — the badge + Edit-hours
                      // affordance work for every type now, not just
                      // HOLIDAY. The badge shows only when workingHours
                      // differs from the type default (so a plain
                      // HOLIDAY_EVE at 5h stays clean).
                      const showWhBadge = isNonDefaultWorkingHours(entry);
                      return (
                        <div key={entry.id} className={cn('mt-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium flex items-center justify-between group', style.bg, style.text)} onClick={(e) => e.stopPropagation()}>
                          <span className="truncate flex items-center gap-1">
                            <span className="truncate">{entry.name}</span>
                            {showWhBadge && (
                              <span className="inline-flex items-center rounded-[5px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-mono tabular-nums px-1.5 py-0.5 shrink-0">
                                {Number(entry.workingHours)}h
                              </span>
                            )}
                          </span>
                          {canWrite && (
                            <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                              <button onClick={() => handleSetWorkingDay(entry)} title="Edit working hours"
                                className="h-4 w-4 flex items-center justify-center rounded hover:bg-white dark:hover:bg-slate-900/50">
                                <Clock className="h-2.5 w-2.5" />
                              </button>
                              <button onClick={async () => { if (await confirm(`Remove "${entry.name}"?`)) deleteMutation.mutate(entry.id); }}
                                className="h-4 w-4 flex items-center justify-center rounded hover:bg-white dark:hover:bg-slate-900/50">
                                <X className="h-2.5 w-2.5" />
                              </button>
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
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">{yearTotalWorking}</span> working days
                {yearTotalHolidays > 0 && <> · <span className="font-mono text-red-500 dark:text-red-400">{yearTotalHolidays} holidays</span></>}
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
                      <span className="text-[10px] font-mono font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-[5px] px-1.5 py-0.5">{m.holidays}</span>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-2 text-center mb-3">
                    <div>
                      <p className="text-lg font-mono font-bold tabular-nums text-slate-700 dark:text-slate-200">{m.working}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">Working</p>
                    </div>
                    <div>
                      <p className={cn('text-lg font-mono font-bold tabular-nums', m.holidays > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-300 dark:text-slate-600')}>{m.holidays}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">Holidays</p>
                    </div>
                    <div>
                      <p className="text-lg font-mono font-bold tabular-nums text-slate-400 dark:text-slate-500">{m.total}</p>
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
          <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
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
              <select value={formType} onChange={(e) => handleFormTypeChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none">
                <option value="HOLIDAY">חג · Holiday</option>
                <option value="HOLIDAY_EVE">ערב חג · Holiday eve</option>
                <option value="CHOL_HAMOED">חוה״מ · Chol-hamoed</option>
                <option value="REST">יום מנוחה · Rest / Company day off</option>
              </select>
            </div>
            {/* HR G2 (2026-10-19) — per-day working hours input. The
                HR monthly engine credits this many standard-hours
                against the user's monthlyStandard; 0 = full-day
                absence. Default seeded from the type on change above. */}
            <div className="w-44">
              <label className="block text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                שעות עבודה · Working hours
              </label>
              <input
                type="number"
                step="0.25"
                min={0}
                max={24}
                value={formWorkingHours}
                onChange={(e) => setFormWorkingHours(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] font-medium text-slate-400 dark:text-slate-500">
                0 = יום מלא היעדרות; עד dailyStandardHours
              </p>
            </div>
            <button type="submit" disabled={!formName.trim() || createMutation.isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {createMutation.isPending ? 'Adding...' : 'Add Day'}
            </button>
          </form>
        </div>
      )}

      {/* Working hours modal — People UX M1 on shared Modal.
          HR G2 (2026-10-19) — modal now edits CalendarDay.workingHours
          directly (replaces the old halfDayUntil-string field) and is
          reachable for every row type, not just HOLIDAY. */}
      {workingDayEdit && (
        <Modal
          open
          onClose={() => setWorkingDayEdit(null)}
          title="Set Working Hours"
          description={
            <>
              Set the per-day working hours for <strong>{workingDayEdit.name}</strong>. 0 means the day is a full-day absence; the HR engine credits this many standard-hours against the user's monthlyStandard.
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
                {updateMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        >
          <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">
            שעות עבודה · Working hours
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={24}
              step="0.25"
              value={workingDayEdit.workingHours}
              onChange={(e) => setWorkingDayEdit({ ...workingDayEdit, workingHours: e.target.value })}
              className="w-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <span className="text-[13px] text-slate-500 dark:text-slate-400">
              0 = יום מלא היעדרות; עד dailyStandardHours
            </span>
          </div>
        </Modal>
      )}

      {/* All Non-Working Days list — read-only viewers see the list but
          no row-level edit / delete controls.
          Wave 3 A (2026-10-20) — sort nearest-upcoming first, then past
          chronologically; filters for name/type/date-range above. */}
      {(data ?? []).length > 0 && (() => {
        const todayStart = new Date(today);
        todayStart.setHours(0, 0, 0, 0);
        const nameNeedle = listNameFilter.trim().toLowerCase();
        const fromMs = listDateFrom ? new Date(listDateFrom + 'T00:00:00').getTime() : -Infinity;
        const toMs = listDateTo ? new Date(listDateTo + 'T23:59:59.999').getTime() : Infinity;
        const filtered = (data as any[]).filter((d) => {
          if (listTypeFilter !== 'all' && d.type !== listTypeFilter) return false;
          if (nameNeedle && !(d.name ?? '').toLowerCase().includes(nameNeedle)) return false;
          const dMs = new Date(d.date).getTime();
          if (dMs < fromMs || dMs > toMs) return false;
          return true;
        });
        const sorted = [...filtered].sort((a, b) => {
          const aMs = new Date(a.date).getTime();
          const bMs = new Date(b.date).getTime();
          const aFuture = aMs >= todayStart.getTime();
          const bFuture = bMs >= todayStart.getTime();
          if (aFuture !== bFuture) return aFuture ? -1 : 1;
          return aMs - bMs;
        });
        const hasFilters = nameNeedle !== '' || listTypeFilter !== 'all' || listDateFrom !== '' || listDateTo !== '';
        return (
          <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">All Non-Working Days</h3>
              <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">{sorted.length}</span>
                {hasFilters && (
                  <> / <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500">{(data as any[]).length}</span></>
                )}{' '}days
              </p>
            </div>

            {/* Filter row — planwise-design form inputs. */}
            <div className="flex flex-wrap items-end gap-2 mb-3">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={listNameFilter}
                  onChange={(e) => setListNameFilter(e.target.value)}
                  placeholder="Search by event name…"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="w-44">
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Type
                </label>
                <select
                  value={listTypeFilter}
                  onChange={(e) => setListTypeFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                >
                  <option value="all">All types</option>
                  <option value="HOLIDAY">חג · Holiday</option>
                  <option value="HOLIDAY_EVE">ערב חג · Eve</option>
                  <option value="CHOL_HAMOED">חוה״מ · Chol-hamoed</option>
                  <option value="REST">יום מנוחה · Rest</option>
                  <option value="REGULAR">רגיל · Regular</option>
                </select>
              </div>
              <div className="w-40">
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  From
                </label>
                <input
                  type="date"
                  value={listDateFrom}
                  onChange={(e) => setListDateFrom(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="w-40">
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  To
                </label>
                <input
                  type="date"
                  value={listDateTo}
                  min={listDateFrom || undefined}
                  onChange={(e) => setListDateTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono tabular-nums text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setListNameFilter('');
                    setListTypeFilter('all');
                    setListDateFrom('');
                    setListDateTo('');
                  }}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              {sorted.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-slate-400 dark:text-slate-500">
                  No non-working days match these filters.
                </p>
              ) : sorted.map((d: any) => {
                const style = TYPE_STYLES[d.type] ?? TYPE_STYLES.CHOL_HAMOED;
                const isPast = new Date(d.date) < todayStart;
                // HR G2 (2026-10-19) — show a "Nh" badge whenever the
                // row's workingHours differs from the type default, for
                // every type (not just HOLIDAY). Edit affordance is now
                // visible for every row.
                const showWhBadge = isNonDefaultWorkingHours(d);
                return (
                  <div key={d.id} className={cn('flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50', isPast && 'opacity-50')}>
                    <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', style.dot)} />
                    <span className="text-[13px] font-medium text-slate-700 dark:text-slate-200 w-32">{new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s+/g, '-')}</span>
                    <span className="text-[13px] text-slate-800 dark:text-slate-100 flex-1 flex items-center gap-2">
                      <span>{d.name}</span>
                      {showWhBadge && (
                        <span className="inline-flex items-center rounded-[5px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-mono tabular-nums px-1.5 py-0.5">
                          {Number(d.workingHours)}h
                        </span>
                      )}
                    </span>
                    <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide', style.bg, style.text)}>{TYPE_LABEL[d.type] ?? d.type}</span>
                    {canWrite && (
                      <>
                        <button onClick={() => handleSetWorkingDay(d)}
                          className="rounded px-2 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                          title="Edit working hours">
                          <Clock className="h-3.5 w-3.5 inline mr-1" />Edit hours
                        </button>
                        <button onClick={async () => { if (await confirm(`Remove "${d.name}"?`)) deleteMutation.mutate(d.id); }}
                          className="rounded p-1 text-slate-300 dark:text-slate-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
