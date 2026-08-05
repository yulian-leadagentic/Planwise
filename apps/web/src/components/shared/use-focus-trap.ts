/**
 * Focus trap utility shared between the Modal shell and the TaskDrawer.
 *
 * Extracted from components/shared/modal.tsx so any modal-shaped
 * surface (dialogs, right-side drawers, popovers-with-focus, …) can
 * enforce the same WCAG 2.2 AA behavior without reimplementing:
 *   - Tab / Shift+Tab wrap around the first/last focusable descendant.
 *   - If the container has no focusable descendants, focus is parked
 *     on the container itself (which the caller MUST make tabbable
 *     via `tabIndex={-1}`).
 *
 * The hook only handles the TAB TRAP. Open-focus, restore-focus, and
 * Escape behavior stay with the caller — the Modal shell wires them
 * together, and the TaskDrawer wants a customised Escape (guarded so
 * inline sub-editors get first shot at cancelling the field).
 */
import { useEffect } from 'react';

// Same selector set the WAI-ARIA authoring docs recommend. Elements
// marked `data-focus-skip` are excluded so callers can opt individual
// controls out without changing tabindex.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('data-focus-skip') && el.offsetParent !== null,
  );
}

/**
 * Trap Tab / Shift+Tab focus inside `containerRef` while `active` is
 * true. No-op when inactive. Listener attaches at document level so
 * focus can be moving between the trigger button and the container's
 * first render without missing the initial Tab.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement>,
) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = getFocusable(containerRef.current);
      if (focusables.length === 0) {
        e.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      // Wrap-around trap: Shift+Tab off the first goes to the last;
      // Tab off the last goes back to the first.
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, containerRef]);
}
