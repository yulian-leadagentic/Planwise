import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reusable multi-select dropdown for filter bars.
 *
 * - Empty selection = "all" (no filter). The trigger reads "All {noun}".
 * - One selection = the chosen label inline on the trigger.
 * - Many = "{first} + N more".
 *
 * The popover has a search box (filters the list by substring), a
 * "Clear all" shortcut, and per-option checkboxes. Closes on outside
 * click or Escape.
 *
 * Designed to be drop-in for both string-keyed (deliverable / service
 * names) and number-keyed (project IDs) filters — `T extends string |
 * number`.
 */
export interface MultiSelectOption<T extends string | number> {
  value: T;
  label: string;
  /** Optional small grey suffix shown after the label. */
  hint?: string;
}

interface MultiSelectFilterProps<T extends string | number> {
  options: MultiSelectOption<T>[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
  /** Plural noun used in the placeholder, e.g. "Services" → "All Services". */
  placeholder: string;
  /** Optional title attribute on the trigger. */
  title?: string;
  /** Tailwind width class on the trigger (default w-48). */
  triggerClassName?: string;
}

export function MultiSelectFilter<T extends string | number>({
  options,
  selected,
  onChange,
  placeholder,
  title,
  triggerClassName,
}: MultiSelectFilterProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape. Listener only attached while open so we
  // don't pay for it on every other render.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const toggle = (value: T) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  // Trigger label — read like "All Services" / "BIM Coordination" /
  // "BIM Coordination + 2 more" so the user can see at a glance how many
  // they've narrowed to without opening the popover.
  const triggerLabel = useMemo(() => {
    if (selected.size === 0) return `All ${placeholder}`;
    const labels = options.filter((o) => selected.has(o.value)).map((o) => o.label);
    if (labels.length === 1) return labels[0];
    return `${labels[0]} + ${labels.length - 1} more`;
  }, [selected, options, placeholder]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title ?? placeholder}
        className={cn(
          'flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent',
          triggerClassName ?? 'w-48',
        )}
      >
        <span className={cn('truncate', selected.size === 0 && 'text-slate-500')}>
          {triggerLabel}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>

      {open && (
        // dir="ltr" on the popover so the checkbox / label / hint flow stays
        // consistent on RTL Hebrew pages — otherwise the row reverses and
        // the unchecked box overlaps the first character of the label,
        // making it look like the letter is missing.
        // start-0 lines the popover with the trigger's logical-start edge
        // in both LTR (left) and RTL (right) layouts, avoiding the off-screen
        // clip we hit with hard-coded left-0.
        <div dir="ltr" className="absolute start-0 top-full z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg">
          {/* Search + clear-all */}
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400"
            />
            {selected.size > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100"
                title="Clear all"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>

          {/* Option list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-slate-400 italic">No matches</p>
            ) : (
              filtered.map((o) => {
                const isOn = selected.has(o.value);
                return (
                  <button
                    key={String(o.value)}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-left hover:bg-slate-50',
                      isOn && 'bg-blue-50/40',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border-2',
                        // Unchecked: thicker slate-400 border + slight bg
                        // so the box reads as a distinct element instead
                        // of disappearing into the white popover background
                        // (which made labels look like their first letter
                        // was missing).
                        isOn
                          ? 'border-blue-500 bg-blue-500 text-white'
                          : 'border-slate-400 bg-slate-50',
                      )}
                    >
                      {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                    </div>
                    <span className="flex-1 truncate text-slate-700">{o.label}</span>
                    {o.hint && <span className="text-[11px] text-slate-400">{o.hint}</span>}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer counter — tells the user how many they have on. */}
          {selected.size > 0 && (
            <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
              {selected.size} selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
