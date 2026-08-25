import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UserAvatar } from './user-avatar';

/**
 * Reusable multi-select for people. Chips live inside the trigger, an
 * inline search input filters the option list alphabetically, and each
 * row carries an avatar + optional subtitle (role, discipline, …).
 *
 * Keyboard model:
 *   • Focus the input → typing filters the list
 *   • ArrowDown / ArrowUp — move highlight through the visible options
 *   • Enter — toggle the highlighted option
 *   • Backspace on an empty input — remove the last chip
 *   • Escape — close the popover
 *
 * Built as its own component (not an extension of MultiSelectFilter)
 * because the two have different trigger contracts: MultiSelectFilter
 * summarizes with text ("Alice + 2 more"), PeopleMultiSelect renders
 * actual removable chips. They share the popover conventions (dir="ltr",
 * z-50 to beat sticky headers, slate palette, `rounded-md` menu) so
 * they read as siblings on the same page. (fix/people-filter, 2026-08-25.)
 */
export interface Person {
  userId: number;
  displayName: string;
  avatarUrl?: string | null;
  /** Small secondary line — role, discipline, department, ... */
  subtitle?: string | null;
}

interface PeopleMultiSelectProps {
  people: Person[];
  value: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
  /** Tailwind width class on the trigger container (default w-64). */
  triggerClassName?: string;
  /** Optional aria/title label — defaults to placeholder. */
  title?: string;
}

export function PeopleMultiSelect({
  people,
  value,
  onChange,
  placeholder = 'All people',
  triggerClassName,
  title,
}: PeopleMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Options are always alphabetically sorted — the retested surface
  // shipped as an unsorted native <select>, and users can't binary-search
  // a random list. Case-insensitive locale compare so "Élie" doesn't
  // land after "Zoe" on Hebrew/EU locales.
  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })),
    [people],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedPeople;
    return sortedPeople.filter((p) =>
      p.displayName.toLowerCase().includes(q)
      || (p.subtitle?.toLowerCase().includes(q) ?? false),
    );
  }, [sortedPeople, query]);

  // Constrain the highlight to the visible slice — the user typing
  // narrows the list, so the previous cursor position often points past
  // the end and should snap back to the first row.
  useEffect(() => {
    if (highlightIdx >= filtered.length) setHighlightIdx(0);
  }, [filtered.length, highlightIdx]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const chips = useMemo(
    () => value
      .map((id) => sortedPeople.find((p) => p.userId === id))
      .filter((p): p is Person => !!p),
    [value, sortedPeople],
  );

  // Close on outside click + Escape. Attached only while open so we
  // pay the listener cost only when it can fire.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Auto-focus the input when opening. Wraps in a microtask so the DOM
  // has painted the element before we call focus().
  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  const toggle = (id: number) => {
    if (selectedSet.has(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };
  const removeChip = (id: number) => onChange(value.filter((v) => v !== id));
  const clearAll = () => onChange([]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = filtered[highlightIdx];
      if (p) toggle(p.userId);
    } else if (e.key === 'Backspace' && !query && value.length > 0) {
      // Empty input + Backspace = pop the last chip. Matches the
      // ubiquitous "email-composer to-field" pattern.
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative inline-block', triggerClassName ?? 'w-64')}
    >
      {/*
        Trigger. Renders as a chip container in place of a plain button
        so the click surface stretches to include the chips (clicking a
        chip's × removes it, clicking anywhere else opens the popover).
      */}
      <div
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title ?? placeholder}
        onClick={(e) => {
          // Ignore clicks that originated on the chip × or nested buttons.
          if ((e.target as HTMLElement).closest('[data-people-chip-x]')) return;
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        tabIndex={0}
        className={cn(
          'flex min-h-[40px] w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] hover:border-slate-400',
          'dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-500',
          'focus-visible:border-blue-500 focus-visible:outline-none',
          open && 'border-blue-500',
        )}
      >
        {chips.length === 0 && (
          <span className="pl-1 text-slate-500 dark:text-slate-400 truncate">
            {placeholder}
          </span>
        )}
        {chips.map((p) => (
          <span
            key={p.userId}
            className="flex items-center gap-1 rounded-[5px] bg-blue-50 dark:bg-blue-900/30 pl-1 pr-1 py-0.5 text-[12px] text-blue-700 dark:text-blue-200"
          >
            <UserAvatar
              firstName={p.displayName.split(' ')[0] ?? ''}
              lastName={p.displayName.split(' ').slice(1).join(' ') ?? ''}
              avatarUrl={p.avatarUrl ?? undefined}
              size="xs"
              className="h-4 w-4 text-[8px]"
            />
            <span className="max-w-[120px] truncate font-medium">{p.displayName}</span>
            <button
              type="button"
              data-people-chip-x
              onClick={(e) => { e.stopPropagation(); removeChip(p.userId); }}
              aria-label={`Remove ${p.displayName}`}
              className="rounded p-0.5 text-blue-500 hover:bg-blue-100 dark:hover:bg-blue-800/50 hover:text-blue-700 dark:hover:text-blue-100"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
      </div>

      {open && (
        // dir="ltr" for RTL parity — the option rows read left-to-right
        // even on Hebrew pages so the avatar sits before the name.
        // z-50 beats the sticky page/table headers.
        <div
          dir="ltr"
          role="listbox"
          aria-multiselectable="true"
          className="absolute start-0 top-full z-50 mt-1 w-72 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
        >
          {/* Search + clear-all */}
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlightIdx(0); }}
              onKeyDown={onInputKeyDown}
              placeholder="Search people…"
              aria-label="Search people"
              className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
            {value.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                aria-label="Clear all selected people"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                title="Clear all"
              >
                <X className="h-3 w-3" aria-hidden="true" /> Clear
              </button>
            )}
          </div>

          {/* Options list. `max-h-64 overflow-y-auto` keeps very large
              teams from pushing the trigger off screen. */}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-slate-400 dark:text-slate-500 italic">
                {query ? `No people match "${query}"` : 'No people'}
              </p>
            ) : (
              filtered.map((p, i) => {
                const isOn = selectedSet.has(p.userId);
                const isHighlighted = i === highlightIdx;
                const initialsSource = p.displayName.split(/\s+/).filter(Boolean);
                const first = initialsSource[0] ?? '';
                const last = initialsSource.slice(1).join(' ');
                return (
                  <button
                    key={p.userId}
                    type="button"
                    role="option"
                    aria-selected={isOn}
                    onMouseEnter={() => setHighlightIdx(i)}
                    onClick={() => toggle(p.userId)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
                      isHighlighted ? 'bg-slate-100 dark:bg-slate-800/60' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                      isOn && 'bg-blue-50/40 dark:bg-blue-900/20',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border-2',
                        isOn
                          ? 'border-blue-500 bg-blue-500 text-white'
                          : 'border-slate-400 dark:border-slate-500 bg-slate-50 dark:bg-slate-800/50',
                      )}
                    >
                      {isOn && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
                    </div>
                    <UserAvatar
                      firstName={first}
                      lastName={last}
                      avatarUrl={p.avatarUrl ?? undefined}
                      size="xs"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-slate-700 dark:text-slate-200">{p.displayName}</span>
                      {p.subtitle && (
                        <span className="block truncate text-[11px] text-slate-400 dark:text-slate-500">
                          {p.subtitle}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer count — same font-mono tabular-nums as the rest of
              our numeric surfaces so a "12 selected" caption doesn't
              wobble as it changes. */}
          {value.length > 0 && (
            <div className="border-t border-slate-100 dark:border-slate-800 px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="font-mono tabular-nums">{value.length}</span> selected
            </div>
          )}
        </div>
      )}
    </div>
  );
}
