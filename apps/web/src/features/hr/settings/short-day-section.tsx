import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { TextField } from '@/components/shared/field';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { hrApi, type HrSettings, type UpdateHrSettingsPayload } from '../api/hr.api';

/**
 * HR Phase B4 (2026-10-15) — the "Short Day" section of /hr/settings.
 * 3 inputs — holiday-eve hours, chol-hamoed hours, min hours/day. All
 * three are strict `0 < v <= 24` client + server side.
 *
 * HR Clerk (hr:read only) sees the current values but Save is hidden.
 */
export function ShortDaySection() {
  const { can } = usePermissions();
  const canWrite = can('hr', 'write');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<HrSettings>({
    queryKey: ['hr', 'settings'],
    queryFn: () => hrApi.getSettings(),
    staleTime: 60 * 1000,
  });

  const [form, setForm] = useState({
    shortDayHoursHolidayEve: '',
    shortDayHoursCholHamoed: '',
    minHoursPerDay: '',
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setForm({
      shortDayHoursHolidayEve: String(data.shortDayHoursHolidayEve),
      shortDayHoursCholHamoed: String(data.shortDayHoursCholHamoed),
      minHoursPerDay: String(data.minHoursPerDay),
    });
  }, [data]);

  const save = useMutation({
    mutationFn: (payload: UpdateHrSettingsPayload) => hrApi.updateSettings(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'settings'] });
      notify.success('HR settings saved');
    },
    onError: (e: any) => notify.apiError(e, 'Failed to save HR settings'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const he = Number(form.shortDayHoursHolidayEve);
    const ch = Number(form.shortDayHoursCholHamoed);
    const mn = Number(form.minHoursPerDay);
    for (const [label, v] of [
      ['Holiday-eve hours', he],
      ['Chol-hamoed hours', ch],
      ['Min hours per day', mn],
    ] as const) {
      if (!Number.isFinite(v) || v <= 0 || v > 24) {
        setError(`${label} must be greater than 0 and at most 24.`);
        return;
      }
    }
    save.mutate({
      shortDayHoursHolidayEve: he,
      shortDayHoursCholHamoed: ch,
      minHoursPerDay: mn,
    });
  };

  const dirty =
    data &&
    (Number(form.shortDayHoursHolidayEve) !== data.shortDayHoursHolidayEve ||
      Number(form.shortDayHoursCholHamoed) !== data.shortDayHoursCholHamoed ||
      Number(form.minHoursPerDay) !== data.minHoursPerDay);

  if (isLoading || !data) {
    return (
      <div className="py-8 text-center text-[13px] text-slate-400 dark:text-slate-500">
        Loading settings…
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-[640px] space-y-5">
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-4">
        <p className="text-[13px] text-slate-600 dark:text-slate-300">
          השעות שעובד זכאי לדווח ביום מקוצר (ערב חג / חול המועד), והמינימום
          הנדרש ליום עבודה רגיל. השינוי משפיע על כל חישובי הנוכחות
          הקבוצתיים ב-HR.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <TextField
          label="Holiday eve · ערב חג (hours)"
          name="shortDayHoursHolidayEve"
          type="number"
          step="0.25"
          min={0.01}
          max={24}
          disabled={!canWrite}
          value={form.shortDayHoursHolidayEve}
          inputClassName="font-mono"
          onChange={(e) =>
            setForm((f) => ({ ...f, shortDayHoursHolidayEve: e.target.value }))
          }
        />
        <TextField
          label="Chol-hamoed · חול המועד (hours)"
          name="shortDayHoursCholHamoed"
          type="number"
          step="0.25"
          min={0.01}
          max={24}
          disabled={!canWrite}
          value={form.shortDayHoursCholHamoed}
          inputClassName="font-mono"
          onChange={(e) =>
            setForm((f) => ({ ...f, shortDayHoursCholHamoed: e.target.value }))
          }
        />
        <TextField
          label="Min hours / day · מינימום ליום"
          name="minHoursPerDay"
          type="number"
          step="0.25"
          min={0.01}
          max={24}
          disabled={!canWrite}
          value={form.minHoursPerDay}
          inputClassName="font-mono"
          onChange={(e) => setForm((f) => ({ ...f, minHoursPerDay: e.target.value }))}
        />
      </div>

      {error && (
        <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>
      )}

      {canWrite && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
            Last updated · {new Date(data.updatedAt).toLocaleString()}
          </p>
          <button
            type="submit"
            disabled={!dirty || save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </form>
  );
}
