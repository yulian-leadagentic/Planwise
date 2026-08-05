import { Archive } from 'lucide-react';
import { useState } from 'react';
import { useCloseProject, useReopenProject } from '@/hooks/use-projects';
import { useConfirm } from '@/components/shared/confirm-dialog';

/**
 * Close / Reopen control in the project header. Renders one of two
 * buttons depending on whether the project is already closed —
 * confirmation prompt on close because the visibility change is
 * surprising; reopen is one-click since nothing is destructive.
 */
export function ProjectCloseControl({ project, projectId }: { project: any; projectId: number }) {
  const confirm = useConfirm();
  const closeMutation = useCloseProject();
  const reopenMutation = useReopenProject();
  const isClosed = !!project.closedAt;
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isClosed) {
            reopenMutation.mutate(projectId);
          } else {
            setShowCloseConfirm(true);
          }
        }}
        disabled={closeMutation.isPending || reopenMutation.isPending}
        className={
          isClosed
            ? 'bg-white dark:bg-slate-900 border border-emerald-200 hover:border-emerald-400 text-emerald-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-emerald-50 disabled:opacity-50'
            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50'
        }
      >
        {isClosed ? 'Re-open' : 'Close project'}
      </button>

      {/* Styled close-confirm — replaces the native browser confirm()
          which doesn't match the rest of the app and rendered an ugly
          dark dialog on the user's laptop. Same shape as the other
          confirm modals (pendingZoneMove, pendingTaskDelete, etc.):
          backdrop, centered card, header with icon, body, footer with
          Cancel + primary action. (T3.6 polish, 2026-06-29.) */}
      {showCloseConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
          onClick={() => setShowCloseConfirm(false)}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[460px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Archive className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Close this project?</h3>
                <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">
                  "{project.name}" will be hidden from the default project list.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 text-[13px] text-slate-700 dark:text-slate-200 space-y-2">
              <p>Closing keeps all data intact — tasks, time entries, files, history all stay.</p>
              <p className="text-slate-500 dark:text-slate-400">
                You can re-open it later from this same button. Filter the project list with
                <span className="font-semibold text-slate-700 dark:text-slate-200"> Status → Closed</span> to find it.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCloseConfirm(false);
                  closeMutation.mutate(projectId);
                }}
                disabled={closeMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                Close project
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
