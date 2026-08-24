/**
 * Fallback UI shown by <Sentry.ErrorBoundary /> when a React render/subtree
 * throws. Follows docs/PLANWISE_DESIGN_SYSTEM.md:
 *   - `rounded-[14px]` card, slate palette, no shadow (matches confirm-dialog /
 *     log-time-dialog surface treatment)
 *   - `focus-visible:border-blue-500` focus ring on the primary action
 *   - No stack in prod — the stack goes to Sentry, not to the user
 *
 * Reuses the small centered layout instead of leaning on <EmptyState/>: the
 * empty state icon-in-circle framing reads as "we've got nothing to show"
 * rather than "something went wrong", which is a different user signal.
 */

import { AlertTriangle } from 'lucide-react';

interface Props {
  /** Sentry passes an error object; kept optional so this can render bare. */
  error?: unknown;
}

export function ErrorFallback({ error }: Props) {
  const isDev = import.meta.env.DEV;
  const message = error instanceof Error ? error.message : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] p-6">
      <div className="w-full max-w-md rounded-[14px] border border-[#E2E8F0] bg-white p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FEF2F2]">
            <AlertTriangle className="h-5 w-5 text-[#DC2626]" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-[#0F172A]">
              Something went wrong
            </h2>
            <p className="mt-1 text-[13px] text-[#64748B]">
              Try reloading. If this keeps happening, please contact your admin.
            </p>

            {isDev && message && (
              <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-[#E2E8F0] bg-[#FAFBFC] p-2 text-[11px] font-mono text-[#334155]">
                {message}
              </pre>
            )}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-[10px] border border-[#E2E8F0] bg-[#2563EB] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#1D4ED8] focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
