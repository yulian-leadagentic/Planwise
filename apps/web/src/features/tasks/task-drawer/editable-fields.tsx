import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';

/* -------------------------------------------------------------------------- */
/*  Inline-editable primitives — ported from task-detail-page.tsx so the      */
/*  drawer has parity with the old page (task name, description, numbers,    */
/*  dates). Kept file-local (single caller) instead of promoting to /shared. */
/* -------------------------------------------------------------------------- */

export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400 dark:text-slate-500 shrink-0">{label}:</span>
      <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200 font-medium">{children}</span>
    </div>
  );
}

export function EditableText({
  value,
  onSave,
  className,
  placeholder,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn('inline-block w-full text-left truncate rounded px-1 -mx-1 hover:bg-slate-100 dark:hover:bg-slate-800', className)}
        title="Click to edit"
      >
        {value?.trim() ? value : <span className="italic text-slate-400 dark:text-slate-500">{placeholder ?? 'Click to edit'}</span>}
      </button>
    );
  }

  return (
    <input
      type="text"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val !== value) onSave(val);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (val !== value) onSave(val);
          setEditing(false);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setVal(value);
          setEditing(false);
        }
      }}
      autoFocus
      className={cn('w-full rounded border border-blue-300 dark:border-blue-500 bg-white dark:bg-slate-900 px-2 py-0.5 outline-none focus:border-blue-500', className)}
    />
  );
}

export function EditableTextarea({
  value,
  onSave,
  placeholder,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full text-left rounded-md border border-transparent hover:border-slate-200 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 px-2 py-1.5 min-h-[36px]"
      >
        {value?.trim()
          ? <p className="whitespace-pre-wrap text-[13px] text-slate-700 dark:text-slate-200">{value}</p>
          : <p className="text-[12px] italic text-slate-400 dark:text-slate-500">{placeholder ?? 'Click to add'}</p>}
      </button>
    );
  }

  return (
    <textarea
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val !== value) onSave(val);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setVal(value);
          setEditing(false);
        }
      }}
      autoFocus
      rows={5}
      className="w-full rounded-md border border-blue-300 dark:border-blue-500 bg-white dark:bg-slate-900 px-2 py-1.5 text-[13px] focus:outline-none focus:border-blue-500 resize-y"
    />
  );
}

export function EditableNumber({
  value,
  onSave,
  min,
  max,
  suffix = '',
}: {
  value: number | null | undefined;
  onSave: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ''));
  useEffect(() => setVal(String(value ?? '')), [value]);

  const save = () => {
    const num = Number(val);
    if (!Number.isNaN(num) && num !== value) {
      const clamped =
        min != null && max != null ? Math.min(max, Math.max(min, num))
        : min != null ? Math.max(min, num)
        : max != null ? Math.min(max, num)
        : num;
      onSave(clamped);
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center rounded px-1 -mx-1 hover:bg-slate-100 dark:hover:bg-slate-800 tabular-nums"
        title="Click to edit"
      >
        {value != null ? `${value}${suffix}` : <span className="italic text-slate-400 dark:text-slate-500">—</span>}
      </button>
    );
  }

  return (
    <input
      type="number"
      value={val}
      min={min}
      max={max}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); setVal(String(value ?? '')); setEditing(false); }
      }}
      autoFocus
      className="w-24 rounded border border-blue-300 dark:border-blue-500 bg-white dark:bg-slate-900 px-2 py-0.5 text-sm tabular-nums outline-none focus:border-blue-500"
    />
  );
}

export function EditableDate({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => void;
}) {
  const initial = value ? String(value).slice(0, 10) : '';
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(initial);
  useEffect(() => setVal(initial), [initial]);

  const save = () => {
    // Empty input clears the date; the /tasks PATCH accepts null.
    if (val !== initial) onSave(val || null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center rounded px-1 -mx-1 hover:bg-slate-100 dark:hover:bg-slate-800 tabular-nums"
        title="Click to edit"
      >
        {initial ? formatDate(initial) : <span className="italic text-slate-400 dark:text-slate-500">—</span>}
      </button>
    );
  }

  return (
    <input
      type="date"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); setVal(initial); setEditing(false); }
      }}
      autoFocus
      className="rounded border border-blue-300 dark:border-blue-500 bg-white dark:bg-slate-900 px-2 py-0.5 text-sm outline-none focus:border-blue-500"
    />
  );
}
