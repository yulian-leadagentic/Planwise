import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronLeft, ChevronRight, X, Trash2, Download, Calendar } from 'lucide-react';
import { useState, useMemo } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

const TYPE_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  holiday: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  company_day_off: { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  half_day: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  special: { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
};

// Israeli national holidays — generates dates for any given year
function getIsraeliHolidays(year: number): Array<{ date: string; name: string; nameHe: string }> {
  // These are approximate Gregorian dates — in production would use Hebrew calendar library
  // Dates shift each year based on the Hebrew calendar
  const holidays: Record<number, Array<{ date: string; name: string; nameHe: string }>> = {
    2025: [
      { date: `2025-03-14`, name: 'Purim', nameHe: 'פורים' },
      { date: `2025-04-13`, name: 'Pesach (1st)', nameHe: 'פסח (יום א)' },
      { date: `2025-04-14`, name: 'Pesach (2nd)', nameHe: 'פסח (יום ב)' },
      { date: `2025-04-19`, name: 'Pesach (7th)', nameHe: 'פסח (יום ז)' },
      { date: `2025-04-24`, name: 'Yom HaShoah', nameHe: 'יום השואה' },
      { date: `2025-05-01`, name: 'Yom HaZikaron', nameHe: 'יום הזיכרון' },
      { date: `2025-05-02`, name: 'Yom HaAtzmaut', nameHe: 'יום העצמאות' },
      { date: `2025-06-02`, name: 'Shavuot', nameHe: 'שבועות' },
      { date: `2025-09-23`, name: 'Rosh Hashana (1st)', nameHe: 'ראש השנה (יום א)' },
      { date: `2025-09-24`, name: 'Rosh Hashana (2nd)', nameHe: 'ראש השנה (יום ב)' },
      { date: `2025-10-02`, name: 'Yom Kippur', nameHe: 'יום כיפור' },
      { date: `2025-10-07`, name: 'Sukkot (1st)', nameHe: 'סוכות (יום א)' },
      { date: `2025-10-14`, name: 'Simchat Torah', nameHe: 'שמחת תורה' },
    ],
    2026: [
      { date: `2026-03-03`, name: 'Purim', nameHe: 'פורים' },
      { date: `2026-04-02`, name: 'Pesach (1st)', nameHe: 'פסח (יום א)' },
      { date: `2026-04-03`, name: 'Pesach (2nd)', nameHe: 'פסח (יום ב)' },
      { date: `2026-04-08`, name: 'Pesach (7th)', nameHe: 'פסח (יום ז)' },
      { date: `2026-04-16`, name: 'Yom HaShoah', nameHe: 'יום השואה' },
      { date: `2026-04-23`, name: 'Yom HaZikaron', nameHe: 'יום הזיכרון' },
      { date: `2026-04-24`, name: 'Yom HaAtzmaut', nameHe: 'יום העצמאות' },
      { date: `2026-05-22`, name: 'Shavuot', nameHe: 'שבועות' },
      { date: `2026-09-12`, name: 'Rosh Hashana (1st)', nameHe: 'ראש השנה (יום א)' },
      { date: `2026-09-13`, name: 'Rosh Hashana (2nd)', nameHe: 'ראש השנה (יום ב)' },
      { date: `2026-09-21`, name: 'Yom Kippur', nameHe: 'יום כיפור' },
      { date: `2026-09-26`, name: 'Sukkot (1st)', nameHe: 'סוכות (יום א)' },
      { date: `2026-10-03`, name: 'Simchat Torah', nameHe: 'שמחת תורה' },
    ],
    2027: [
      { date: `2027-03-23`, name: 'Purim', nameHe: 'פורים' },
      { date: `2027-04-22`, name: 'Pesach (1st)', nameHe: 'פסח (יום א)' },
      { date: `2027-04-23`, name: 'Pesach (2nd)', nameHe: 'פסח (יום ב)' },
      { date: `2027-04-28`, name: 'Pesach (7th)', nameHe: 'פסח (יום ז)' },
      { date: `2027-05-06`, name: 'Yom HaShoah', nameHe: 'יום השואה' },
      { date: `2027-05-13`, name: 'Yom HaZikaron', nameHe: 'יום הזיכרון' },
      { date: `2027-05-14`, name: 'Yom HaAtzmaut', nameHe: 'יום העצמאות' },
      { date: `2027-06-11`, name: 'Shavuot', nameHe: 'שבועות' },
      { date: `2027-10-02`, name: 'Rosh Hashana (1st)', nameHe: 'ראש השנה (יום א)' },
      { date: `2027-10-03`, name: 'Rosh Hashana (2nd)', nameHe: 'ראש השנה (יום ב)' },
      { date: `2027-10-11`, name: 'Yom Kippur', nameHe: 'יום כיפור' },
      { date: `2027-10-16`, name: 'Sukkot (1st)', nameHe: 'סוכות (יום א)' },
      { date: `2027-10-23`, name: 'Simchat Torah', nameHe: 'שמחת תורה' },
    ],
  };
  return holidays[year] ?? holidays[2026] ?? [];
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

export function CalendarDaysPage() {
  const queryClient = useQueryClient();
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('company_day_off');

  const { data, isLoading } = useQuery({
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
      setFormType('company_day_off');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add calendar day'),
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
    setSelectedDate(dateKey);
    setShowAddForm(true);
    setFormName('');
    setFormType('company_day_off');
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

  const importHolidays = async (year: number) => {
    const holidays = getIsraeliHolidays(year);
    const existingDates = new Set((data ?? []).map((d: any) => typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0]));
    let added = 0;
    for (const h of holidays) {
      if (existingDates.has(h.date)) continue;
      try {
        await client.post('/calendar', { date: h.date, name: `${h.nameHe} (${h.name})`, type: 'holiday' });
        added++;
      } catch { /* skip duplicates */ }
    }
    queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
    if (added > 0) notify.success(`Imported ${added} Israeli holidays for ${year}`, { code: 'CAL-IMPORT-200' });
    else notify.info(`All ${year} holidays already exist`);
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar Days"
        description="Manage holidays, company days off, and non-working days"
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setShowImport(!showImport)}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Download className="h-4 w-4" /> Import Israeli Holidays
            </button>
          </div>
        }
      />

      {/* Import holidays dialog */}
      {showImport && (
        <div className="rounded-[14px] border border-blue-200 bg-blue-50/30 p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-2">Import Israeli National Holidays</h3>
          <p className="text-[12px] text-slate-500 mb-3">
            Automatically add all Israeli national holidays (פורים, פסח, שבועות, ראש השנה, יום כיפור, סוכות, etc.) for the selected year.
            Holidays that already exist will be skipped.
          </p>
          <div className="flex items-center gap-3">
            <select value={importYear} onChange={(e) => setImportYear(Number(e.target.value))}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              {[2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="text-[12px] text-slate-400">{getIsraeliHolidays(importYear).length} holidays</span>
            <button onClick={() => importHolidays(importYear)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Import {importYear}
            </button>
            <button onClick={() => setShowImport(false)} className="text-sm text-slate-400 hover:text-slate-600">Cancel</button>
          </div>
          {/* Preview */}
          <div className="mt-3 max-h-40 overflow-y-auto">
            <table className="w-full text-[11px]">
              <tbody>
                {getIsraeliHolidays(importYear).map((h) => (
                  <tr key={h.date} className="border-b border-blue-100">
                    <td className="py-1 pr-3 text-slate-500 w-24">{h.date}</td>
                    <td className="py-1 pr-3 font-medium text-slate-700">{h.nameHe}</td>
                    <td className="py-1 text-slate-500">{h.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Month navigation + working days count */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="rounded-md p-2 hover:bg-slate-100"><ChevronLeft className="h-5 w-5" /></button>
        <div className="text-center">
          <h2 className="text-lg font-bold text-slate-900">{monthName}</h2>
          <p className="text-[12px] text-slate-400">
            <span className="font-semibold text-slate-700">{monthWorkingDays}</span> working days this month
          </p>
        </div>
        <button onClick={nextMonth} className="rounded-md p-2 hover:bg-slate-100"><ChevronRight className="h-5 w-5" /></button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px]">
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500" /> Holiday</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-amber-500" /> Company Day Off</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500" /> Half Day</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-purple-500" /> Special</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-200" /> Weekend</div>
      </div>

      {/* Calendar Grid */}
      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {DAY_NAMES.map((day) => (
            <div key={day} className="px-2 py-2.5 text-center text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              {day}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {monthDays.map(({ date, inMonth }, idx) => {
            const dateKey = formatDateKey(date);
            const entries = calendarMap.get(dateKey) ?? [];
            const isToday = dateKey === todayKey;
            const weekend = isWeekend(date);
            const hasEntries = entries.length > 0;
            const isSelected = selectedDate === dateKey;

            return (
              <div
                key={idx}
                onClick={() => inMonth && handleDateClick(dateKey)}
                className={cn(
                  'min-h-[90px] border-b border-r border-slate-100 px-1.5 py-1 cursor-pointer transition-colors',
                  !inMonth && 'bg-slate-50/50 opacity-40',
                  inMonth && weekend && !hasEntries && 'bg-slate-50',
                  inMonth && hasEntries && 'bg-red-50/30',
                  isSelected && 'ring-2 ring-inset ring-blue-500 bg-blue-50/30',
                  inMonth && !hasEntries && !weekend && 'hover:bg-blue-50/20',
                )}
              >
                {/* Day number */}
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'text-[13px] font-medium',
                    !inMonth ? 'text-slate-300' : isToday ? 'text-white bg-blue-600 rounded-full w-7 h-7 flex items-center justify-center' : 'text-slate-700',
                    weekend && inMonth && !isToday && 'text-slate-400',
                  )}>
                    {date.getDate()}
                  </span>
                  {weekend && inMonth && (
                    <span className="text-[9px] text-slate-400 font-medium">Weekend</span>
                  )}
                </div>

                {/* Calendar entries */}
                {entries.map((entry: any) => {
                  const style = TYPE_STYLES[entry.type] ?? TYPE_STYLES.special;
                  return (
                    <div
                      key={entry.id}
                      className={cn('mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium flex items-center justify-between group', style.bg, style.text)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="truncate">{entry.name}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); if (confirm(`Remove "${entry.name}"?`)) deleteMutation.mutate(entry.id); }}
                        className="hidden group-hover:flex h-4 w-4 items-center justify-center rounded hover:bg-white/50 shrink-0"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Add Day Form (appears when a date is clicked) */}
      {showAddForm && selectedDate && (
        <div className="rounded-[14px] border border-blue-200 bg-blue-50/30 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">
              Add Non-Working Day — {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </h3>
            <button onClick={() => { setShowAddForm(false); setSelectedDate(null); }} className="rounded-md p-1.5 hover:bg-slate-200 text-slate-400">
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-[12px] font-semibold text-slate-600 mb-1">Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Team Building Day, Rosh Hashana"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
            </div>
            <div className="w-48">
              <label className="block text-[12px] font-semibold text-slate-600 mb-1">Type</label>
              <select value={formType} onChange={(e) => setFormType(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                <option value="holiday">Holiday</option>
                <option value="company_day_off">Company Day Off</option>
                <option value="half_day">Half Day</option>
                <option value="special">Special</option>
              </select>
            </div>
            <button type="submit" disabled={!formName.trim() || createMutation.isPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {createMutation.isPending ? 'Adding...' : 'Add Day'}
            </button>
          </form>
        </div>
      )}

      {/* Upcoming days list below calendar */}
      {(data ?? []).length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-bold text-slate-900 mb-3">All Non-Working Days</h3>
          <div className="space-y-1.5">
            {(data as any[]).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((d: any) => {
              const style = TYPE_STYLES[d.type] ?? TYPE_STYLES.special;
              const isPast = new Date(d.date) < today;
              return (
                <div key={d.id} className={cn('flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50', isPast && 'opacity-50')}>
                  <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', style.dot)} />
                  <span className="text-[13px] font-medium text-slate-700 w-32">{new Date(d.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                  <span className="text-[13px] text-slate-800 flex-1">{d.name}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', style.bg, style.text)}>{d.type?.replace(/_/g, ' ')}</span>
                  <button onClick={() => { if (confirm(`Remove "${d.name}"?`)) deleteMutation.mutate(d.id); }}
                    className="rounded p-1 text-slate-300 hover:text-red-600 hover:bg-red-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
