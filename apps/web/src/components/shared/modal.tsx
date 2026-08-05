/**
 * Accessible Modal shell (WCAG 2.2 AA).
 *
 * The single canonical modal wrapper for the Planwise app. Every
 * confirm / prompt / dialog should reach the screen through this
 * component (directly or via ConfirmDialog on top).
 *
 * Behaviors this shell implements — none of them optional:
 *   - role="dialog" + aria-modal="true" + aria-labelledby wired to
 *     the visible title. Callers just pass `title`; we create the id.
 *   - Focus is TRAPPED inside the modal while open. Tab / Shift+Tab
 *     wrap around the first/last focusable element.
 *   - Focus lands on the modal on open — either an explicit
 *     `initialFocusRef` or the first focusable descendant (title's
 *     close button as the last-resort target so focus never falls
 *     off the page).
 *   - The trigger element that had focus BEFORE the modal opened is
 *     remembered and re-focused when the modal closes. Passing
 *     `restoreFocusRef` lets callers override with an explicit target.
 *   - Escape closes the modal (unless `escapeDisabled`).
 *   - Backdrop click closes UNLESS a dirty-form guard says otherwise
 *     — pass `isDirty` + optional `dirtyWarning` and the shell asks
 *     "Discard changes?" via a native confirm-in-modal before it
 *     dismisses. Cancel keeps the modal open.
 *   - Body scroll is locked while any modal is open.
 *   - Close button is REQUIRED and always visible; its label defaults
 *     to "Close" but can be customized (`closeLabel`).
 *
 * Not built on Radix / shadcn Dialog because neither is installed and
 * we don't want to add a new dep for a single shell. If the app ever
 * pulls Radix in, this file is the one place to swap.
 */

import { useEffect, useId, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// Selector used by getFocusable(). Same set most WAI-ARIA authoring
// docs recommend — tabbable elements, positive/zero tabindex, no
// disabled or hidden.
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

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('data-focus-skip') && el.offsetParent !== null,
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Right-aligned footer buttons; caller owns layout. */
  footer?: React.ReactNode;
  /** Optional label override for the close-X (default "Close"). */
  closeLabel?: string;
  /** Skip the close-X entirely — rare (e.g. forced-choice dialogs). */
  hideCloseButton?: boolean;
  /** Element to focus on open. Defaults to first focusable in body. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /** Element to focus on close. Defaults to whoever was focused
   *  BEFORE the modal opened (usually the trigger). */
  restoreFocusRef?: React.RefObject<HTMLElement>;
  /** When true, a native confirm() guards backdrop / Escape close. */
  isDirty?: boolean;
  /** Message shown by the dirty guard. */
  dirtyWarning?: string;
  /** Skip Escape-to-close (rare — e.g. destructive final-confirm). */
  escapeDisabled?: boolean;
  /** Tailwind width class on the panel; defaults to a reasonable md. */
  widthClass?: string;
  /** Extra classes on the panel container. */
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
  hideCloseButton = false,
  initialFocusRef,
  restoreFocusRef,
  isDirty = false,
  dirtyWarning = 'Discard your unsaved changes?',
  escapeDisabled = false,
  widthClass = 'w-[440px] max-w-[92vw]',
  className,
}: ModalProps) {
  // Stable id for aria-labelledby / aria-describedby.
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Wrap onClose with the dirty-guard so both the backdrop and the
  // close-X (and Escape) share one path.
  const requestClose = useCallback(() => {
    if (isDirty) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(dirtyWarning);
      if (!ok) return;
    }
    onClose();
  }, [isDirty, dirtyWarning, onClose]);

  // Focus management: capture the previously-focused element when we
  // open, then restore it (or the caller's explicit target) on close.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;

    // Focus target: caller's explicit ref → first focusable in the
    // body → the panel itself (as tabindex=-1).
    const focus = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      const focusables = getFocusable(panelRef.current);
      if (focusables.length > 0) {
        focusables[0].focus();
        return;
      }
      panelRef.current?.focus();
    };
    // Delay one frame so layout is committed + close-X is mounted.
    const raf = requestAnimationFrame(focus);

    return () => {
      cancelAnimationFrame(raf);
      // Restore focus. If caller specified a target, use that; else
      // whatever had focus before we opened.
      const target = restoreFocusRef?.current ?? previouslyFocused.current;
      // Wrap in a rAF so the element definitely exists (e.g. the
      // trigger button may have re-rendered during the close).
      requestAnimationFrame(() => {
        try { target?.focus(); } catch { /* target may have unmounted; no-op */ }
      });
    };
  }, [open, initialFocusRef, restoreFocusRef]);

  // Body scroll lock while any modal is open. Multiple modals share
  // the same style toggle — restored when the last one closes.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Escape + focus-trap keyboard handling.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !escapeDisabled) {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = getFocusable(panelRef.current);
      if (focusables.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap-around trap: focus the "other end" when you Tab off it.
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, escapeDisabled, requestClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      // NB: NO onClick on this outer wrapper — clicks on the wrapper
      // that AREN'T on the backdrop or panel (e.g. bubbling from
      // portalled tooltips) should NOT dismiss. Backdrop is a
      // dedicated sibling below.
    >
      {/* Backdrop — click to close via requestClose (dirty-guard aware). */}
      <div
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm"
        onClick={requestClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-[85vh] flex-col overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl',
          widthClass,
          className,
        )}
      >
        <header className="flex items-start gap-3 border-b border-slate-100 dark:border-slate-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
                {description}
              </p>
            )}
          </div>
          {!hideCloseButton && (
            <button
              type="button"
              onClick={requestClose}
              aria-label={closeLabel}
              className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
