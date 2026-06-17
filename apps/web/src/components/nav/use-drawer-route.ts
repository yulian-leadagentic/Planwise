import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Drives a drawer/modal's open-task-ID via a URL query param so:
 *   • browser back / refresh restores the drawer,
 *   • outbound links from inside the drawer can record a `state.return`
 *     pointing at THIS page WITH the drawer open — the destination's
 *     ReturnPill will then bring the user back to exactly where they were.
 *
 * Closing the drawer uses replace-history so the back button doesn't
 * reopen the drawer the user just dismissed.
 *
 * Default param key is "task" — pages with multiple drawer kinds can pass
 * a different key (e.g. "contact") to keep them independent.
 */
export function useDrawerRoute(paramKey = 'task') {
  const [params, setParams] = useSearchParams();
  const raw = params.get(paramKey);
  const parsed = raw ? Number(raw) : NaN;
  const drawerId = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  const openDrawer = useCallback(
    (id: number) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(paramKey, String(id));
          return next;
        },
        { replace: false },
      );
    },
    [paramKey, setParams],
  );

  const closeDrawer = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(paramKey);
        return next;
      },
      { replace: true },
    );
  }, [paramKey, setParams]);

  return { drawerId, openDrawer, closeDrawer };
}
