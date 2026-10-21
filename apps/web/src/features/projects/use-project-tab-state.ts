import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

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
 *   • `projectId` arriving late or invalid (NaN / 0 / negative / not
 *     finite) is treated as PENDING: no read, no write, hold the default.
 *     On the first commit where projectId becomes a positive integer the
 *     hydrate effect reads from storage and writes land under the real
 *     key. This matters because PlanningView is reached through a lazy
 *     `Suspense` route whose parent (ProjectDetailPage / PlanningPage)
 *     derives `projectId` from `Number(useParams().id)` — a brief NaN at
 *     the top of the Suspense boundary would otherwise anchor the
 *     syncedKey to `planwise:project:NaN:*` and silently drop every
 *     persist back to the real `planwise:project:<id>:*` slot.
 *
 * Race-condition note:
 *   `value` and the key it was computed under are bundled in a SINGLE
 *   state object (`{ syncedKey, value }`), so a projectId swap can't
 *   leak the pre-hydrate value into the new slot. The persist effect
 *   only fires when `state.syncedKey === key`, which is true only after
 *   the re-hydrate commit has landed.
 *
 * Scope: for a flag or filter block owned by a single tab. For state
 * that is per-zone, per-row, or otherwise nested, serialise through
 * JSON cleanly (plain objects / arrays, not Map or Set) — see the
 * Planning tab's filter block for an example.
 */
export function useProjectTabState<T>(
  projectId: number,
  tabKey: string,
  defaultValue: T,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const validProjectId = Number.isFinite(projectId) && projectId > 0;
  const key = validProjectId ? `planwise:project:${projectId}:${tabKey}` : null;

  // `syncedKey` tracks which storage key the current `value` was computed
  // under; the write effect compares it to the current `key` so a swap
  // never flushes a stale value into the new slot. Starts null when the
  // mount hits an invalid projectId — the hydrate effect fills it in on
  // the first valid key.
  const [state, setState] = useState<{ syncedKey: string | null; value: T }>(() => ({
    syncedKey: key,
    value: key != null ? readStorage(key, defaultValue) : defaultValue,
  }));

  // Latest defaultValue in a ref so the hydrate effect can read it
  // without participating in deps (callers often pass fresh literals).
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;

  // Re-hydrate when the storage key appears (projectId became valid) or
  // changes (project swap mid-mount). The bundled setState swaps
  // `syncedKey` + `value` atomically — no intermediate render can see
  // the new key with the old value, so the persist effect below never
  // writes a stale value to a new slot.
  useEffect(() => {
    if (key == null) return;
    setState((prev) =>
      prev.syncedKey === key
        ? prev
        : { syncedKey: key, value: readStorage(key, defaultValueRef.current) },
    );
  }, [key]);

  // Persist on value changes. Fires only when the current `state` was
  // computed under the current `key` — guards both the pending (null
  // key) case and the single-commit window right after a projectId swap
  // where `key` has already updated but `syncedKey` has not.
  useEffect(() => {
    if (key == null) return;
    if (state.syncedKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(state.value));
    } catch {
      /* localStorage unavailable (private mode, quota, disabled). */
    }
  }, [key, state]);

  // Expose a React-looking `setValue` whose signature matches the
  // standard useState dispatcher so call sites that pass a functional
  // updater (`setBulkCollapsed(v => !v)`) keep working unchanged.
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((updater) => {
    setState((prev) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: T) => T)(prev.value)
          : updater;
      return next === prev.value ? prev : { syncedKey: prev.syncedKey, value: next };
    });
  }, []);

  return [state.value, setValue] as const;
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
