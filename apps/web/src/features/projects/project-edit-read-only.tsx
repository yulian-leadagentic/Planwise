import { Link } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';

/**
 * QA6 round 3 (26.11) · what /projects/:id/edit shows to someone who
 * can open the project but cannot manage it (not the leader, not an
 * Admin: `projectManageActions(...).edit` is false). Before, he got the
 * full form and a 403 on Save (PATCH /projects/:id runs
 * assertProjectManage). Now a read-only notice and a way back.
 */
export const PROJECT_EDIT_READ_ONLY_MESSAGE = 'Only the project leader or an administrator can edit this project.';

export function ProjectEditReadOnly({ projectId, projectName }: { projectId: number; projectName?: string | null }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-800/50">
      <div className="max-w-[640px] mx-auto py-8 px-4">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mb-6">Edit Project</h1>
        <div
          role="status"
          className="flex items-start gap-3 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-amber-50 dark:bg-amber-500/10">
            <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Read only</h2>
            {projectName && (
              <p dir="auto" className="mt-0.5 text-sm font-semibold text-slate-700 dark:text-slate-200 break-words">
                {projectName}
              </p>
            )}
            <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">{PROJECT_EDIT_READ_ONLY_MESSAGE}</p>
            <Link
              to={`/projects/${projectId}`}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 transition-all duration-150 hover:border-slate-400 dark:hover:border-slate-500"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to project
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
