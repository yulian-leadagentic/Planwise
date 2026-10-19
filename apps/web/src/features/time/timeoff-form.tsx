import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, FileText, Upload, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { hrApi, type TimeCategory, type TimeCategoryKind } from '@/features/hr/api/hr.api';
import { timeApi } from '@/api/time.api';
import { invalidateAfterTimeEntry } from './invalidate-after-time-entry';

/**
 * HR F6 (2026-10-19) — shared Timeoff mode form.
 *
 * Mounted inside the two self-service time surfaces (weekly timesheet
 * TimeEntryFormPopup + log-time-dialog) when the user flips the
 * LocationToggle to "חופש". Hides every Project/Task/time-range control
 * on the parent form (the parent conditionally renders this component
 * instead of its own Project/Task/bucket controls).
 *
 * Data flow:
 *   • Picker fetched from `GET /hr/time-categories` (F5). The response
 *     is grouped by `kind`:
 *       - ABSENCE          → saved to POST /hr/employees/:callerId/absences
 *       - WORK_NON_PROJECT → saved to POST /time-entries with specialHourBucketId
 *       - QUOTA            → same as WORK_NON_PROJECT (bucket entry)
 *   • Document upload is conditional on the picked category's
 *     `requiresDocument` flag — pre-upload to the employee attachments
 *     table (same path HR uses) and pass the resulting id as
 *     `documentFileId` on the absence create. Buckets never require a
 *     document in this UX (buckets A + C don't carry that flag in Phase B
 *     seed), so the upload UI only ever appears for ABSENCE.
 *
 * Multi-day DAY-unit absences are supported (dateFrom..dateTo span, the
 * BE auto-expands bereavement). Bucket entries are single-day only —
 * the parent surfaces are "log time on a date" and the DB column is
 * one date per row; a multi-day pick for a bucket shows an inline hint
 * and forces the save to use `dateFrom` only.
 *
 * HOUR-unit categories are single-day only (hours on one calendar day),
 * so `dateTo` is hidden when the picked category is HOUR.
 */

export interface TimeoffFormProps {
  /** Default date for the single-day DAY entries + the first day of a span. */
  defaultDate: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function TimeoffForm({ defaultDate, onSaved, onCancel }: TimeoffFormProps) {
  const callerId = useAuthStore((s) => s.user?.id) as number | undefined;
  const queryClient = useQueryClient();

  const { data: categories = [], isLoading } = useQuery<TimeCategory[]>({
    queryKey: ['hr', 'time-categories'],
    queryFn: () => hrApi.listTimeCategories(),
    staleTime: 10 * 60 * 1000,
    // Keep the UX quiet when a non-employee session hits this surface;
    // the picker's own empty-state copy will tell them why.
    retry: false,
  });

  const grouped = useMemo(() => {
    const absence = categories.filter((c) => c.kind === 'ABSENCE');
    const workNonProject = categories.filter((c) => c.kind === 'WORK_NON_PROJECT');
    const quota = categories.filter((c) => c.kind === 'QUOTA');
    return { absence, workNonProject, quota };
  }, [categories]);

  // Composite picker value: `${kind}:${id}` so the three groups don't
  // alias ids across tables (an AbsenceType id and a SpecialHourBucket
  // id are two different id spaces).
  const [pickedKey, setPickedKey] = useState<string>('');
  const picked = useMemo<TimeCategory | null>(() => {
    if (!pickedKey) return null;
    const [kind, idRaw] = pickedKey.split(':');
    const id = Number(idRaw);
    return (
      categories.find((c) => {
        if (c.kind !== kind) return false;
        if (kind === 'ABSENCE') return c.absenceTypeId === id;
        return c.bucketId === id;
      }) ?? null
    );
  }, [pickedKey, categories]);

  const [dateFrom, setDateFrom] = useState(defaultDate);
  const [dateTo, setDateTo] = useState(defaultDate);
  const [amount, setAmount] = useState<string>('');
  const [note, setNote] = useState('');
  const [documentFileId, setDocumentFileId] = useState<number | null>(null);
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset dateTo to match dateFrom whenever dateFrom moves ahead of it,
  // and whenever a HOUR-unit category is picked (single-day lock).
  useEffect(() => {
    if (!picked) return;
    if (picked.unit === 'HOUR') {
      setDateTo(dateFrom);
    } else if (dateTo < dateFrom) {
      setDateTo(dateFrom);
    }
  }, [dateFrom, picked, dateTo]);

  // Prefill amount sensibly when picking a category:
  //   • DAY unit → 1 day (user can toggle 0.5 / 1 or type a sum)
  //   • HOUR unit → leave blank; the user types their hours
  useEffect(() => {
    if (!picked) return;
    setAmount((prev) => {
      if (prev !== '') return prev; // don't overwrite a user-typed value
      return picked.unit === 'DAY' ? '1' : '';
    });
    // Clear any upload the user attached for a prior category — a doc
    // for one absence type should never bleed into another.
    setDocumentFileId(null);
    setDocumentName(null);
  }, [picked?.kind, picked?.absenceTypeId, picked?.bucketId]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      if (!callerId) throw new Error('No current user');
      return hrApi.uploadAttachment(callerId, file);
    },
    onSuccess: (resp) => {
      setDocumentFileId(resp.id);
      setDocumentName(resp.fileName);
      notify.success(`הועלה "${resp.fileName}"`);
    },
    onError: (e: any) => notify.apiError(e, 'Upload failed'),
  });

  const isMultiDay = picked?.unit === 'DAY' && dateTo > dateFrom;
  const multiDayNotAllowedForBucket =
    picked != null &&
    (picked.kind === 'WORK_NON_PROJECT' || picked.kind === 'QUOTA') &&
    picked.unit === 'DAY' &&
    isMultiDay;

  const save = useMutation({
    mutationFn: async () => {
      if (!picked) throw new Error('No category picked');
      if (!callerId) throw new Error('No current user');

      const amt = Number(amount);
      if (picked.kind === 'ABSENCE') {
        return hrApi.createAbsence(callerId, {
          absenceTypeId: picked.absenceTypeId!,
          dateFrom,
          dateTo: dateTo !== dateFrom ? dateTo : undefined,
          amount: amt,
          documentFileId: documentFileId ?? undefined,
          note: note.trim() || undefined,
        });
      }

      // WORK_NON_PROJECT or QUOTA → bucket-tagged TimeEntry.
      // Hours vs days: a DAY-unit bucket entry currently maps to a
      // one-row TimeEntry on `dateFrom` using the user-entered amount
      // as a day count — but TimeEntry.minutes is minutes, not days.
      // The spec forbids multi-day for buckets here; for DAY-unit a
      // single-day pick with amount=1 (or 0.5) multiplies against the
      // employee's dailyStandardHours when the engine rolls up. We
      // write that as minutes on `dateFrom` using 8h40 as the
      // Phase-F1 default when the daily-hours lookup isn't trivially
      // reachable from this form. The server still accepts/stores
      // whatever minutes we send; the engine reads bucket minutes
      // directly.
      const minutes =
        picked.unit === 'HOUR'
          ? Math.round(amt * 60)
          : Math.round(amt * 8.4 * 60); // DAY → amount × 8.4h daily default (F1)

      return timeApi.createEntry({
        date: dateFrom,
        minutes,
        note: note.trim() || undefined,
        isBillable: false,
        specialHourBucketId: picked.bucketId!,
      });
    },
    onSuccess: () => {
      // Both branches change surfaces that read /time + HR ledgers. The
      // shared invalidator covers tasks/projects/planning; also kick
      // the HR absences/time-categories caches so the HR drawer and
      // the picker refresh without a reload.
      invalidateAfterTimeEntry(queryClient);
      queryClient.invalidateQueries({ queryKey: ['hr'] });
      notify.success(picked?.kind === 'ABSENCE' ? 'Absence logged' : 'Time entry created', {
        code: picked?.kind === 'ABSENCE' ? 'HR-ABSENCE-200' : 'TIME-CREATE-200',
      });
      onSaved();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to save'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!picked) {
      setError('בחר קטגוריה');
      return;
    }
    if (!dateFrom) {
      setError('תאריך התחלה חובה');
      return;
    }
    if (picked.unit === 'DAY' && dateTo && dateTo < dateFrom) {
      setError('תאריך סיום לא יכול להיות לפני תאריך התחלה');
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('כמות חייבת להיות גדולה מאפס');
      return;
    }
    if (picked.requiresDocument && documentFileId == null) {
      setError('נדרש מסמך');
      return;
    }
    save.mutate();
  };

  const canSave =
    !!picked &&
    !!dateFrom &&
    Number(amount) > 0 &&
    !(picked.requiresDocument && documentFileId == null) &&
    !save.isPending &&
    !uploadMut.isPending;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
        <Calendar className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <div className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
          מצב חופש / היעדרות — Timeoff mode
        </div>
      </div>

      {/* Category picker — grouped by kind */}
      <div>
        <label className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
          קטגוריה · Category *
        </label>
        <select
          value={pickedKey}
          onChange={(e) => {
            setPickedKey(e.target.value);
            setAmount(''); // let the prefill effect re-run
          }}
          disabled={isLoading}
          className={cn(
            'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none',
            !pickedKey
              ? 'border-red-300 dark:border-red-500/60 focus:border-red-500'
              : 'border-slate-200 dark:border-slate-700 focus:border-blue-500',
          )}
        >
          <option value="">— בחר קטגוריה —</option>
          {grouped.absence.length > 0 && (
            <optgroup label="היעדרויות">
              {grouped.absence.map((c) => (
                <option key={`ABSENCE:${c.absenceTypeId}`} value={`ABSENCE:${c.absenceTypeId}`}>
                  {c.nameHe} ({c.unit === 'DAY' ? 'ימים' : 'שעות'})
                  {c.requiresDocument ? ' · מסמך חובה' : ''}
                </option>
              ))}
            </optgroup>
          )}
          {grouped.workNonProject.length > 0 && (
            <optgroup label="שעות עבודה שאינן על פרויקט">
              {grouped.workNonProject.map((c) => (
                <option key={`WORK_NON_PROJECT:${c.bucketId}`} value={`WORK_NON_PROJECT:${c.bucketId}`}>
                  {c.nameHe} ({c.unit === 'DAY' ? 'ימים' : 'שעות'})
                </option>
              ))}
            </optgroup>
          )}
          {grouped.quota.length > 0 && (
            <optgroup label="מכסות">
              {grouped.quota.map((c) => (
                <option key={`QUOTA:${c.bucketId}`} value={`QUOTA:${c.bucketId}`}>
                  {c.nameHe} ({c.unit === 'DAY' ? 'ימים' : 'שעות'})
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {!pickedKey && (
          <p className="mt-1 text-[11px] font-medium text-red-600 dark:text-red-400">
            קטגוריה חובה
          </p>
        )}
        {categories.length === 0 && !isLoading && (
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            אין קטגוריות זמינות — פנו למנהל/ת כוח האדם.
          </p>
        )}
      </div>

      {/* Dates — single input for HOUR unit, range for DAY unit */}
      <div className={cn('grid gap-3', picked?.unit === 'HOUR' ? 'grid-cols-1' : 'grid-cols-2')}>
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
            {picked?.unit === 'HOUR' ? 'תאריך · Date' : 'מתאריך · From'} *
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
          />
        </div>
        {picked?.unit !== 'HOUR' && (
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
              עד תאריך · To
            </label>
            <input
              type="date"
              value={dateTo}
              min={dateFrom}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}
      </div>

      {multiDayNotAllowedForBucket && (
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
          לקטגוריה זו נזן יום בודד — בחר תאריך בודד
        </p>
      )}

      {/* Amount — DAY: 0.5/1 quick toggles + numeric; HOUR: numeric hours */}
      <div>
        <label className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
          כמות · Amount ({picked?.unit === 'HOUR' ? 'שעות · hours' : 'ימים · days'}) *
        </label>
        {picked?.unit === 'DAY' && (
          <div className="mb-2 flex gap-2">
            <button
              type="button"
              onClick={() => setAmount('0.5')}
              className={cn(
                'flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold',
                amount === '0.5'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400',
              )}
            >
              חצי יום · 0.5
            </button>
            <button
              type="button"
              onClick={() => setAmount('1')}
              className={cn(
                'flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold',
                amount === '1'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400',
              )}
            >
              יום מלא · 1
            </button>
          </div>
        )}
        <input
          type="number"
          step={picked?.unit === 'HOUR' ? '0.25' : '0.5'}
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none"
          placeholder={picked?.unit === 'HOUR' ? 'e.g. 2.5' : 'e.g. 1'}
        />
      </div>

      {/* Note */}
      <div>
        <label className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
          הערה · Note
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="פרטים נוספים…"
          className="w-full resize-none rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Document — only shown when the picked category requires it (or
          when the user attached one already — handy for optional cases). */}
      {picked?.requiresDocument && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                מסמך מצורף · Document <span className="text-red-500">*</span>
              </p>
              {documentFileId && documentName ? (
                <span className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 dark:text-blue-400">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="truncate max-w-[240px]">{documentName}</span>
                </span>
              ) : (
                <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                  חובה להעלות מסמך לסוג זה
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {documentFileId != null && (
                <button
                  type="button"
                  onClick={() => {
                    setDocumentFileId(null);
                    setDocumentName(null);
                  }}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploadMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              >
                <Upload className="h-3 w-3" />
                {uploadMut.isPending ? 'מעלה…' : '+ צרף מסמך'}
              </button>
              <input
                ref={fileRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadMut.mutate(f);
                  if (fileRef.current) fileRef.current.value = '';
                }}
              />
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[12px] font-medium text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="rounded-lg bg-blue-600 px-5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// Re-export the discriminator so callers importing from this file don't
// need to also pull from the HR api.
export type { TimeCategoryKind };
