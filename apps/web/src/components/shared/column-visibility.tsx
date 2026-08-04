import { useState, useEffect, useRef, useMemo } from 'react';
import { Columns3, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Column visibility customizer (2026-08-02).
 *
 * Every user gets to choose which columns they see on a given screen.
 * The picker is a small popover with a checkbox per column; picks are
 * persisted per (screen key × user browser) in localStorage. Screens
 * that use it call `useColumnVisibility(key, columns)` and get back:
 *   - `visible`: the set of visible column keys
 *   - `isVisible(key)`: cheap check for a specific column
 *   - `Picker`: the popover component to drop in the toolbar
 *
 * Server-side persistence can be layered on later (e.g. a
 * `user_ui_prefs` table); the client-side hook is small enough to
 * swap out without touching the callers.
 */
export interface ColumnDef {
  key: string;
  label: string;
  /** When true, the column can't be hidden (e.g. task name). */
  required?: boolean;
  /** When true, the column starts hidden by default. */
  hiddenByDefault?: boolean;
}

function storageKeyFor(pageKey: string): string {
  return `planwise:column-visibility:${pageKey}:v1`;
}

function loadPrefs(pageKey: string, columns: ColumnDef[]): Set<string> {
  try {
    const raw = localStorage.getItem(storageKeyFor(pageKey));
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* corrupt prefs — fall through to defaults */ }
  const defaults = columns.filter((c) => c.required || !c.hiddenByDefault).map((c) => c.key);
  return new Set(defaults);
}

function savePrefs(pageKey: string, visible: Set<string>) {
  try {
    localStorage.setItem(storageKeyFor(pageKey), JSON.stringify(Array.from(visible)));
  } catch { /* quota exceeded / storage disabled — non-fatal */ }
}

export function useColumnVisibility(pageKey: string, columns: ColumnDef[]) {
  const [visible, setVisible] = useState<Set<string>>(() => loadPrefs(pageKey, columns));

  useEffect(() => {
    savePrefs(pageKey, visible);
  }, [pageKey, visible]);

  const isVisible = (key: string) => visible.has(key);

  const toggle = (key: string) => {
    const col = columns.find((c) => c.key === key);
    if (col?.required) return; // required columns can't be toggled off
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const showAll = () => setVisible(new Set(columns.map((c) => c.key)));
  const resetToDefault = () => setVisible(new Set(columns.filter((c) => c.required || !c.hiddenByDefault).map((c) => c.key)));

  const hiddenCount = useMemo(
    () => columns.filter((c) => !c.required && !visible.has(c.key)).length,
    [columns, visible],
  );

  return { visible, isVisible, toggle, showAll, resetToDefault, hiddenCount };
}

/**
 * Popover UI for the visibility picker. Drop it in the toolbar next
 * to filters. Icon-only when nothing is hidden; shows a small badge
 * with the hidden-count when at least one column is off.
 */
export function ColumnVisibilityPicker({
  columns,
  visible,
  onToggle,
  onShowAll,
  onReset,
  hiddenCount,
  suppressedKeys,
  suppressedReason,
}: {
  columns: ColumnDef[];
  visible: Set<string>;
  onToggle: (key: string) => void;
  onShowAll: () => void;
  onReset: () => void;
  hiddenCount: number;
  /** Columns forced-hidden by an external condition (e.g. active
   *  grouping duplicates the column). Rendered greyed-out with a
   *  tooltip; user's saved preference stays untouched underneath. */
  suppressedKeys?: Set<string>;
  suppressedReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[13px] font-semibold transition-colors',
          hiddenCount > 0
            ? 'border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-400'
            : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300',
        )}
        title="Show / hide columns"
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
        {hiddenCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
            {hiddenCount}
          </span>
        )}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[260px] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white">
          <div className="p-2 border-b border-slate-100 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Visible columns</span>
            <div className="flex items-center gap-2 text-[11px]">
              <button type="button" onClick={onShowAll} className="text-blue-600 hover:text-blue-700 font-semibold">All</button>
              <button type="button" onClick={onReset} className="text-slate-500 hover:text-slate-700 font-semibold">Default</button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {columns.map((c) => {
              const suppressed = suppressedKeys?.has(c.key) ?? false;
              const disabled = c.required || suppressed;
              const tooltip = suppressed ? (suppressedReason ?? 'Hidden by another setting') : undefined;
              return (
                <label
                  key={c.key}
                  title={tooltip}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 text-[12px]',
                    suppressed
                      ? 'text-slate-400 italic cursor-not-allowed bg-slate-50/50'
                      : c.required
                        ? 'text-slate-700 opacity-50 cursor-not-allowed'
                        : 'text-slate-700 hover:bg-slate-50 cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={visible.has(c.key) && !suppressed}
                    onChange={() => !disabled && onToggle(c.key)}
                    disabled={disabled}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex-1">{c.label}</span>
                  {c.required && <Check className="h-3 w-3 text-slate-400" />}
                  {suppressed && <span className="text-[10px] font-semibold text-slate-400">grouping</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
