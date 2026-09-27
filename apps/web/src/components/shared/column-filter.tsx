import { useMemo, useState } from 'react';
import { X } from 'lucide-react';

// QA3 master-handoff · Part B2 — inline column-filter helper for the
// hand-rolled `<table>` pages that DON'T use the shared DataTable.
// A tiny React component + a stable hook: consumers keep their table
// markup and just add one filter row and one call site.
//
// Match modes:
//   • 'contains' (default) — case-insensitive substring
//   • 'exact'              — equality (used for enum <select>)
// Combines every configured column with AND. Empty filter = skip.

export interface ColumnFilterConfig<T> {
  /** Stable key for this filter (typically the column's accessor). */
  colKey: string;
  /** How the input matches the value. Defaults to 'contains'. */
  match?: 'contains' | 'exact';
  /** Pulls a comparable value from a row. Defaults to
   *  `(row as any)[colKey]`. Return null/undefined for "no value". */
  accessor?: (row: T) => string | number | null | undefined;
  /** Present = render as <select> (exact match). */
  options?: Array<{ value: string; label: string }>;
  /** Input placeholder text (contains mode only). */
  placeholder?: string;
}

/** Case-insensitive substring on the raw cell value. */
function stringMatches(raw: unknown, q: string, mode: 'contains' | 'exact'): boolean {
  if (raw == null) return false;
  const target = String(raw).toLowerCase();
  const query = q.toLowerCase();
  return mode === 'exact' ? target === query : target.includes(query);
}

/** Hook driving the {colKey: value} state + filtered rows.
 *
 *  Pass a **stable** (useMemo'd) `config` — the hook uses it directly
 *  in a memo dependency, so a fresh array every render forces useless
 *  recomputation. See consumers for the pattern.
 */
export function useColumnFilters<T>(rows: T[], config: ColumnFilterConfig<T>[]) {
  const [filters, setFilters] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    // Fast path: no filters active → return the input array unchanged
    // so referential equality holds and downstream memos stay warm.
    if (!Object.values(filters).some((v) => v && v.length > 0)) return rows;
    return rows.filter((row) =>
      config.every((c) => {
        const raw = filters[c.colKey];
        if (!raw) return true;
        const value = c.accessor ? c.accessor(row) : (row as any)[c.colKey];
        return stringMatches(value, raw, c.match ?? 'contains');
      }),
    );
  }, [rows, config, filters]);

  const active = Object.values(filters).some((v) => v && v.length > 0);
  const activeCount = Object.values(filters).filter((v) => v && v.length > 0).length;
  const clear = () => setFilters({});
  const set = (colKey: string, value: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) next[colKey] = value;
      else delete next[colKey];
      return next;
    });
  };

  return { filters, set, clear, active, activeCount, filtered };
}

/** Small filter control that matches the shared DataTable's look.
 *  Renders <select> when `config.options` is set, otherwise <input>. */
export function ColumnFilter<T>({
  config,
  value,
  onChange,
  label,
}: {
  config: ColumnFilterConfig<T>;
  value: string;
  onChange: (next: string) => void;
  /** Optional a11y label. Defaults to the colKey. */
  label?: string;
}) {
  const aria = `Filter by ${label ?? config.colKey}`;
  if (config.options && config.options.length > 0) {
    return (
      <select
        aria-label={aria}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-0.5 text-[11px] font-normal text-slate-700 dark:text-slate-200 focus:outline-none focus-visible:border-blue-500"
      >
        <option value="">— All —</option>
        {config.options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      placeholder={config.placeholder ?? 'Filter…'}
      aria-label={aria}
      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-0.5 text-[11px] font-normal placeholder:text-slate-400 dark:placeholder:text-slate-500 text-slate-700 dark:text-slate-200 focus:outline-none focus-visible:border-blue-500"
    />
  );
}

/** Small chip you can render above a hand-rolled table when filters are
 *  active. Wired to the hook's `clear`. */
export function ClearColumnFilters({ activeCount, onClear }: { activeCount: number; onClear: () => void }) {
  if (activeCount <= 0) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs mb-2">
      <span className="text-muted-foreground">
        {activeCount} filter{activeCount === 1 ? '' : 's'} active
      </span>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 px-2 py-0.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <X className="h-3 w-3" aria-hidden="true" /> Clear filters
      </button>
    </div>
  );
}
