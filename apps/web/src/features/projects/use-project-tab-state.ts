import { useEffect, useRef, useState } from 'react';

/**
 * Per-project, per-tab UI state persisted to localStorage.
 *
 * Reusable: Planning tab + Deliverable Planning tab both persist their
 * collapse / filters this way, so switching to another project tab
 * (Kanban, Execution, Team, Files, …) and back restores the user's view.
 *
 * Storage key shape: `planwise:project:<projectId>:<tabKey>`.
 *
 * Edge cases:
 *   • localStorage can throw (private mode, disabled site data, quota).
 *     Every read and write is wrapped in try/catch; failure falls back
 *     to the default silently so the UI still renders.
 *   • Stored shape may be incompatible across releases (schema drift).
 *     JSON.parse failures also fall back to the default; nothing is
 *     mutated in storage until the user next changes a field.
 *   • `projectId` changing mid-mount (navigating from /projects/5 to
 *     /projects/7 without the Planning tab unmounting) swaps the key,
 *     re-reads from storage, and only writes under the current key —
 *     the previous project's slot is never overwritten with the new
 *     project's state.
 *
 * Scope: for a flag or filter block owned by a single tab. For state
 * that is per-zone, per-row, or otherwise nested, serialise through
 * JSON cleanly (plain objects / arrays, not Map or Set) — see the
 * Planning tab's filter block for an example.
 */
export function useProjectTabState<T>(projectId: number, tabKey: string, defaultValue: T) {
  const key = `planwise:project:${projectId}:${tabKey}`;

  const [value, setValue] = useState<T>(() => readStorage(key, defaultValue));

  // The ref tracks which key the current `value` was last synced to.
  // The initial render loads from `key`, so it starts matched.
  const syncedKeyRef = useRef(key);

  // Re-hydrate on key change (e.g. projectId switches while this tab
  // stays mounted). Writes are gated below so we never flush the old
  // project's state into the new project's slot before the re-read.
  useEffect(() => {
    if (syncedKeyRef.current === key) return;
    syncedKeyRef.current = key;
    setValue(readStorage(key, defaultValue));
    // defaultValue is captured intentionally — swapping it mid-mount
    // would be a caller bug and we don't want to churn on unstable
    // literals in the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Persist on value changes, but only when the loaded key still
  // matches: on the render after projectId flips, this effect might
  // fire with the new key before the re-hydrate effect has swapped
  // `value`, so we skip writes until the sync lands.
  useEffect(() => {
    if (syncedKeyRef.current !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* localStorage unavailable (private mode, quota, disabled). */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

function readStorage<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}
