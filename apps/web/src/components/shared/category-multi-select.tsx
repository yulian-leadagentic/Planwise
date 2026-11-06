import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Category filter dropdown — a read-only multi-select styled to match
 * the `ProjectCategoryEditor` visual (color dot + checkbox + name) but
 * shaped like a filter-bar widget rather than an inline chip editor.
 *
 * - Trigger reads "All {placeholder}" / "{first} + N more" like
 *   `MultiSelectFilter`.
 * - Dropdown body mirrors `ProjectCategoryEditor`'s panel: Planwise
 *   design-system card (rounded-xl + soft shadow + black/5 border) with
 *   per-row color dot derived from `ProjectType.color`.
 * - No PRIMARY badge, no star button, no save — filter order doesn't
 *   matter, multi-select is set-valued.
 *
 * Why a new component instead of a variant on `MultiSelectFilter`:
 * the color-dot row is substantively different from the plain checkbox
 * row, and a `variant` prop would push render-prop hooks through
 * `MultiSelectFilter` for a single caller. Keeping the generic filter
 * uncomplicated for its four other uses (Projects, Services, Deliverables,
 * Statuses) was the deciding factor.
 */
export interface CategoryOption {
  value: number;
  label: string;
  /** Hex color from `ProjectType.color`; may be stored with or without a leading `#`. */
  color: string | null;
}

interface CategoryMultiSelectProps {
  options: CategoryOption[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  /** Plural noun used in the placeholder, e.g. "Categories" → "All Categories". */
  placeholder: string;
  /** Optional title attribute on the trigger. */
  title?: string;
  /** Tailwind width class on the trigger (default w-56). */
  triggerClassName?: string;
}

export function CategoryMultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  title,
  triggerClassName,
}: CategoryMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click + Escape. Mirrors MultiSelectFilter so keyboard
  // behavior stays consistent across the filter bar.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        queueMicrotask(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (highlightIdx >= filtered.length) setHighlightIdx(0);
  }, [filtered.length, highlightIdx]);

  const toggle = (value: number) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlightIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlightIdx(Math.max(0, filtered.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[highlightIdx];
      if (o) toggle(o.value);
    }
  };

  const triggerLabel = useMemo(() => {
    if (selected.size === 0) return `All ${placeholder}`;
    const labels = options.filter((o) => selected.has(o.value)).map((o) => o.label);
    if (labels.length === 1) return labels[0];
    return `${labels[0]} + ${labels.length - 1} more`;
  }, [selected, options, placeholder]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={title ?? placeholder}
        aria-label={`${title ?? placeholder} filter — ${selected.size === 0 ? 'All' : `${selected.size} selected`}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent',
          triggerClassName ?? 'w-56',
        )}
      >
        <span className={cn('truncate', selected.size === 0 && 'text-slate-500 dark:text-slate-400')}>
          {triggerLabel}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
      </button>

      {open && (
        // dir="ltr" matches MultiSelectFilter — keep checkbox/label flow
        // consistent on RTL Hebrew pages. z-50 beats sticky headers on
        // the Execution Board.
        <div
          dir="ltr"
          role="listbox"
          aria-multiselectable="true"
          className={cn(
            'absolute start-0 top-full z-50 mt-1 min-w-[220px] rounded-xl bg-white dark:bg-slate-900 p-1.5',
            'border border-black/5 dark:border-slate-700',
            'shadow-[0_12px_40px_rgba(0,0,0,0.12)]',
          )}
        >
          {/* Search + clear — kept because the category list can grow
              past half a dozen rows on larger orgs. */}
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlightIdx(0); }}
              onKeyDown={onInputKeyDown}
              placeholder="Search…"
              aria-label={`Search ${placeholder}`}
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
            {selected.size > 0 && (
              <button
                type="button"
                onClick={clearAll}
                aria-label="Clear all selections"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                title="Clear all"
              >
                <X className="h-3 w-3" aria-hidden="true" /> Clear
              </button>
            )}
          </div>

          {/* Section header — matches ProjectCategoryEditor's label slot,
              minus the "first checked = primary" affordance since this is
              a read-only filter. */}
          <div className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em] px-3 py-1.5">
            Categories
          </div>

          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-slate-400 dark:text-slate-500 italic">No matches</p>
            ) : (
              filtered.map((o, i) => {
                const isOn = selected.has(o.value);
                const isHighlighted = i === highlightIdx;
                const color = normalizeColor(o.color);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={isOn}
                    onMouseEnter={() => setHighlightIdx(i)}
                    onClick={() => toggle(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-left',
                      'text-slate-700 dark:text-slate-200',
                      isHighlighted ? 'bg-slate-100 dark:bg-slate-800/60' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                      isOn && !isHighlighted && 'bg-blue-50/40 dark:bg-blue-900/20',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border-2',
                        isOn
                          ? 'border-blue-500 bg-blue-500 text-white'
                          : 'border-slate-400 dark:border-slate-500 bg-slate-50 dark:bg-slate-800/50',
                      )}
                    >
                      {isOn && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full border border-slate-200 dark:border-slate-700"
                      style={{ backgroundColor: color ?? '#94a3b8' }}
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>

          {selected.size > 0 && (
            <div className="border-t border-slate-100 dark:border-slate-800 px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              {selected.size} selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Backend stores color as either `#RRGGBB` or the raw hex without the
// leading `#` (both shapes appear in seed data). Normalize so inline
// `style` never receives an invalid value. Mirrors the helper in
// `ProjectCategoryEditor` so the two render the same color dot for the
// same stored value.
function normalizeColor(color: string | null | undefined): string | null {
  if (!color) return null;
  return color.startsWith('#') ? color : `#${color}`;
}
