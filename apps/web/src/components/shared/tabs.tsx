import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Shared Tabs (People UX M5 · E-20 / E-27).
 *
 * Replaces the two dozen hand-rolled tab bars in People, Partners,
 * Contacts, Team-tab and Admin. Ships proper roles + arrow-key
 * navigation:
 *   • outer container `role="tablist"`;
 *   • each trigger `role="tab"` + `aria-selected` + `aria-controls`;
 *   • ArrowLeft / ArrowRight / Home / End move focus between tabs
 *     (per WAI-ARIA APG "Tabs" pattern);
 *   • active tab persists in URL `?tab=<value>` when `paramKey` is set,
 *     so a deep-linked share reopens the right sub-view.
 *
 * The panel wrapping (`role="tabpanel"`) is left to the caller — most
 * of our surfaces already handle their own content shell, and we
 * don't want to break existing layouts. We surface the `id`s so
 * callers can wire `aria-controls` / `aria-labelledby` correctly.
 */

export interface TabItem<TValue extends string = string> {
  value: TValue;
  label: ReactNode;
  /** Optional badge / count / icon shown to the right of the label. */
  badge?: ReactNode;
  /** Optional aria-label override for icon-only tabs. */
  ariaLabel?: string;
  disabled?: boolean;
}

interface TabsProps<TValue extends string = string> {
  items: TabItem<TValue>[];
  value: TValue;
  onChange: (next: TValue) => void;
  /** id root — used to derive tab + panel ids. Default 'tabs'. */
  idBase?: string;
  className?: string;
  /** Match the variant of the underlying tab bar. */
  variant?: 'underline' | 'pill';
  /** Optional right-of-tabs content (filters, actions). */
  trailing?: ReactNode;
  /** Optional aria-label on the tablist (screen-reader text). */
  ariaLabel?: string;
}

/** Compute id for a tab trigger button. */
export function tabTriggerId(idBase: string, value: string) {
  return `${idBase}-tab-${value}`;
}
/** Compute id for a tab panel — pair with `aria-labelledby`. */
export function tabPanelId(idBase: string, value: string) {
  return `${idBase}-panel-${value}`;
}

export function Tabs<TValue extends string = string>({
  items,
  value,
  onChange,
  idBase = 'tabs',
  className,
  variant = 'underline',
  trailing,
  ariaLabel,
}: TabsProps<TValue>) {
  const listRef = useRef<HTMLDivElement>(null);

  const enabledIndices = useMemo(
    () => items
      .map((it, i) => (it.disabled ? -1 : i))
      .filter((i) => i >= 0),
    [items],
  );
  const currentIdx = useMemo(
    () => items.findIndex((it) => it.value === value),
    [items, value],
  );

  const focusIdx = useCallback((idx: number) => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-tab-idx="${idx}"]`,
    );
    el?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (enabledIndices.length === 0) return;
      const pos = enabledIndices.indexOf(currentIdx);
      let nextPos = pos;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextPos = (pos + 1 + enabledIndices.length) % enabledIndices.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextPos = (pos - 1 + enabledIndices.length) % enabledIndices.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextPos = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextPos = enabledIndices.length - 1;
      } else {
        return;
      }
      const idx = enabledIndices[nextPos];
      const item = items[idx];
      if (item) {
        onChange(item.value);
        // Wait for React to re-render so the new active button exists.
        requestAnimationFrame(() => focusIdx(idx));
      }
    },
    [enabledIndices, currentIdx, items, onChange, focusIdx],
  );

  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-700', variant === 'pill' && 'border-0', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cn(
          'flex items-center',
          variant === 'underline' ? 'gap-1' : 'gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1',
        )}
      >
        {items.map((item, i) => {
          const selected = item.value === value;
          const disabled = !!item.disabled;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={tabTriggerId(idBase, item.value)}
              aria-selected={selected}
              aria-controls={tabPanelId(idBase, item.value)}
              aria-label={item.ariaLabel}
              disabled={disabled}
              tabIndex={selected ? 0 : -1}
              data-tab-idx={i}
              onClick={() => !disabled && onChange(item.value)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold transition-colors',
                variant === 'underline'
                  ? cn(
                      'px-3 py-2 border-b-2 -mb-px',
                      selected
                        ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                        : 'border-transparent text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100',
                    )
                  : cn(
                      'rounded-md px-3 py-1.5',
                      selected
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100',
                    ),
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <span>{item.label}</span>
              {item.badge != null && (
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

/**
 * Hook that keeps a piece of Tabs state in sync with the URL `?tab=`
 * query string. Callers pass a list of valid values and a default;
 * we validate the incoming URL to prevent typo'd deep-links landing
 * on an invalid tab.
 */
export function useUrlTab<TValue extends string>(
  paramKey: string,
  validValues: readonly TValue[],
  defaultValue: TValue,
): [TValue, (next: TValue) => void] {
  const navigate = useNavigate();
  const location = useLocation();

  const current = useMemo<TValue>(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get(paramKey);
    if (raw && validValues.includes(raw as TValue)) return raw as TValue;
    return defaultValue;
  }, [location.search, paramKey, validValues, defaultValue]);

  // On mount, if the URL has no tab param, normalise to defaultValue silently
  // so the tablist markup renders in a consistent state and axe doesn't flag
  // an "no aria-selected=true" violation.
  useEffect(() => {
    // no-op: current always resolves to a valid TValue thanks to the guard above.
  }, [current]);

  const setTab = useCallback(
    (next: TValue) => {
      const params = new URLSearchParams(location.search);
      if (next === defaultValue) {
        params.delete(paramKey);
      } else {
        params.set(paramKey, next);
      }
      const search = params.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash },
        { replace: true },
      );
    },
    [navigate, location.pathname, location.search, location.hash, paramKey, defaultValue],
  );

  return [current, setTab];
}
