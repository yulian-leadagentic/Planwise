import { Archive } from 'lucide-react';
import { useState } from 'react';
import { useCloseProject, useReopenProject } from '@/hooks/use-projects';
import { Modal } from '@/components/shared/modal';

/**
 * Close / Reopen control in the project header. Renders one of two
 * buttons depending on whether the project is already closed —
 * confirmation prompt on close because the visibility change is
 * surprising; reopen is one-click since nothing is destructive.
 *
 * People UX M1 — the confirmation now uses the shared Modal shell so
 * it gets focus trap, Escape close, focus return, and dark-mode parity
 * out of the box.
 */
export function ProjectCloseControl({ project, projectId }: { project: any; projectId: number }) {
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
            ? 'bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 hover:border-emerald-400 dark:hover:border-emerald-500 text-emerald-700 dark:text-emerald-300 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50'
            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 disabled:opacity-50'
        }
      >
        {isClosed ? 'Re-open' : 'Close project'}
      </button>

      {showCloseConfirm && (
        <Modal
          open
          onClose={() => setShowCloseConfirm(false)}
          title={
            <span className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40" aria-hidden="true">
                <Archive className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </span>
              Close this project?
            </span>
          }
          description={
            <>
              "{project.name}" will be hidden from the default project list.
            </>
          }
          widthClass="w-[460px] max-w-[92vw]"
          footer={
            <>
              <button
                type="button"
                onClick={() => setShowCloseConfirm(false)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCloseConfirm(false);
                  closeMutation.mutate(projectId);
                }}
                disabled={closeMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                Close project
              </button>
            </>
          }
        >
          <div className="text-[13px] text-slate-700 dark:text-slate-200 space-y-2">
            <p>Closing keeps all data intact — tasks, time entries, files, history all stay.</p>
            <p className="text-slate-500 dark:text-slate-400">
              You can re-open it later from this same button. Filter the project list with
              <span className="font-semibold text-slate-700 dark:text-slate-200"> Status → Closed</span> to find it.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
