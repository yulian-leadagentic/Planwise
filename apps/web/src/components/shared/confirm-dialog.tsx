/**
 * ConfirmDialog — the destructive/confirmation modal, built on the
 * shared Modal shell. Two ways to use it:
 *
 * 1. Declarative — for confirmations tied to component-local state:
 *      <ConfirmDialog
 *        open={isOpen}
 *        onClose={() => setOpen(false)}
 *        onConfirm={() => doTheThing()}
 *        title="Delete row?"
 *        description="This can't be undone."
 *        variant="danger"
 *      />
 *
 * 2. Imperative — for one-shot "confirm-then-do" calls that used to
 *    reach for window.confirm():
 *      const confirm = useConfirm();
 *      onClick={async () => {
 *        if (await confirm(`Delete "${row.name}"?`)) doTheThing();
 *      }}
 *    The <ConfirmMount /> component must be rendered once, high in
 *    the tree (see main.tsx / app-router.tsx).
 *
 * Both paths render the SAME Modal shell, so a11y is identical.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Modal } from './modal';

// ─── Declarative API ────────────────────────────────────────────────

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  isLoading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  description = 'This action cannot be undone.',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  isLoading,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {variant === 'danger' && (
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40" aria-hidden="true">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
            </span>
          )}
          {title}
        </span>
      }
      description={description}
      initialFocusRef={confirmBtnRef}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              'rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50',
              variant === 'danger'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700',
            )}
          >
            {isLoading ? 'Loading…' : confirmLabel}
          </button>
        </>
      }
    >
      {/* Body intentionally empty — description sits in the header. */}
      <span className="sr-only">{description}</span>
    </Modal>
  );
}

// ─── Imperative API ─────────────────────────────────────────────────

interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

/** Programmatic replacement for window.confirm(). Await the boolean:
 *  `if (await confirm('Delete?')) deleteMutation.mutate(id);`.
 *  Requires <ConfirmMount /> mounted once in the tree. */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmCtx);
  if (!fn) {
    // Fallback so the app doesn't crash if the provider is missing —
    // logs a warning and defers to window.confirm so behavior is at
    // least preserved. In practice ConfirmMount is at app root.
    if (typeof console !== 'undefined') {
      console.warn('[useConfirm] called outside <ConfirmMount />. Falling back to window.confirm().');
    }
    return async (msg: string) => window.confirm(msg);
  }
  return fn;
}

interface PendingConfirm {
  message: string;
  opts?: ConfirmOptions;
  resolve: (v: boolean) => void;
}

/** Mount ONCE, high in the tree (near the router). Exposes the
 *  useConfirm() promise-based API to every descendant. Renders the
 *  actual ConfirmDialog when a promise is pending. */
export function ConfirmMount({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  // The confirm() implementation handed out via context.
  const confirmFn: ConfirmFn = useCallback((message, opts) => {
    return new Promise<boolean>((resolve) => setPending({ message, opts, resolve }));
  }, []);

  // Referentially-stable value avoids re-renders in every consumer
  // just because ConfirmMount re-rendered.
  const value = useMemo(() => confirmFn, [confirmFn]);

  const resolve = useCallback((v: boolean) => {
    setPending((cur) => {
      cur?.resolve(v);
      return null;
    });
  }, []);

  return (
    <ConfirmCtx.Provider value={value}>
      {children}
      {pending && (
        <ConfirmDialog
          open
          onClose={() => resolve(false)}
          onConfirm={() => resolve(true)}
          title={pending.opts?.title ?? pending.message}
          description={pending.opts?.title ? pending.message : pending.opts?.description ?? ''}
          confirmLabel={pending.opts?.confirmLabel}
          cancelLabel={pending.opts?.cancelLabel}
          variant={pending.opts?.variant ?? 'default'}
        />
      )}
    </ConfirmCtx.Provider>
  );
}
