import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NoAccessProps {
  /** Completes "You don't have access to …" — e.g. "cost rates", "labor categories and their rates". */
  what: string;
  /** Second sentence. Defaults to the same hint the API's permission messages end with. */
  hint?: string;
  /**
   * Full text that replaces "You don't have access to {what}. {hint}" —
   * e.g. the server's own reason from `getPermissionMessage(error)`.
   */
  message?: string;
  /**
   * `inline` (default) — a small note inside a section, card or modal.
   * `page` — a centred block that replaces a whole page's content.
   */
  variant?: 'inline' | 'page';
  className?: string;
}

/**
 * What a section shows instead of its content when the viewer lacks the
 * permission for it (known up front via `usePermissions().can(...)`, or
 * learned from a 403 — `isPermissionDenied(query.error)`). Replaces empty
 * or broken sections and error toasts on load. Neutral surface + amber
 * lock, matching the "No permission" alert of `notify.apiError`.
 */
export function NoAccess({
  what,
  hint = 'Ask your administrator for access.',
  message,
  variant = 'inline',
  className,
}: NoAccessProps) {
  if (variant === 'page') {
    return (
      <div role="status" className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
        <div className="flex h-10 w-10 items-center justify-center rounded-[7px] bg-amber-50 dark:bg-amber-500/10">
          <Lock className="h-[18px] w-[18px] text-amber-600 dark:text-amber-400" aria-hidden="true" />
        </div>
        <h3 className="mt-3 text-[15px] font-bold text-slate-900 dark:text-slate-100">No access</h3>
        <p dir="auto" className="mt-1 max-w-sm text-[13px] text-slate-500 dark:text-slate-400">
          {message ?? <>You don&apos;t have access to {what}. {hint}</>}
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-[#FAFBFC] dark:bg-slate-800/40 px-3 py-2',
        className,
      )}
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p dir="auto" className="text-xs text-slate-500 dark:text-slate-400">
        {message ?? (
          <>
            <span className="font-medium text-slate-700 dark:text-slate-200">You don&apos;t have access to {what}.</span>{' '}
            {hint}
          </>
        )}
      </p>
    </div>
  );
}
