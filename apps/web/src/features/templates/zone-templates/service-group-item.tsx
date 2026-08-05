import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, ChevronRight, ChevronDown, X, Copy } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// ---------------------------------------------------------------------------
// Service Group Item (expandable, view-only tasks)
// ---------------------------------------------------------------------------

export function ServiceGroupItem({ serviceName, tasks, templateId, onDeleteAll, readOnly, servicePhase }: {
  serviceName: string;
  tasks: any[];
  templateId: number;
  onDeleteAll: () => void;
  readOnly?: boolean;
  servicePhase?: { name: string; code?: string | null } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // Pending per-task delete — drives the ConfirmDialog. null = no dialog open.
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const queryClient = useQueryClient();
  // Per-task delete inside a deliverable-derived service group. The tasks in
  // these groups are root-level template tasks (`template_tasks`), so the
  // correct endpoint is `/templates/tasks/:id` — NOT `/templates/zone-tasks/:id`,
  // which targets a different table (`template_zone_tasks`) and would risk
  // silently deleting an unrelated zone-task that happens to share the id.
  const deleteTask = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/tasks/${id}`).then((r) => r.data),
    onSuccess: () => {
      // Broad invalidation by the ['templates', ...] prefix: the task may
      // live either in THIS template OR in a template referenced by one of
      // this template's zones (those tasks are fetched under
      // ['templates', refTemplateId]). Refreshing only the current template
      // key would leave the referenced-template's cached data stale, so the
      // deleted task would keep showing until a manual refresh — exactly the
      // "screen didn't refresh after delete" bug. The prefix invalidation
      // catches every cached templates query at once.
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
      setPendingDelete(null);
    },
    onError: (err: any) => { notify.apiError(err, 'Failed to delete task'); setPendingDelete(null); },
  });
  const totalHours = tasks.reduce((s: number, t: any) => s + Number(t.defaultBudgetHours || 0), 0);
  const totalAmount = tasks.reduce((s: number, t: any) => s + Number(t.defaultBudgetAmount || 0), 0);

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-blue-50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 text-blue-500" /> : <ChevronRight className="h-3 w-3 text-blue-500" />}
        <Copy className="h-3.5 w-3.5 shrink-0 text-blue-600" />
        <span className="text-sm text-blue-700 font-medium">Deliverable: {serviceName}</span>
        {servicePhase && (
          <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700">
            {servicePhase.name}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''} &middot; {totalHours}h &middot; {'\u20AA'}{totalAmount.toLocaleString()}
        </span>
        {!readOnly && <button
          onClick={(e) => { e.stopPropagation(); onDeleteAll(); }}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
          title="Remove this deliverable and all its tasks"
        >
          <X className="h-3 w-3" />
        </button>}
      </div>
      {expanded && (
        <div className="ml-6 border-l border-blue-200 pl-3 mb-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">Code</th>
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="px-2 py-1 text-right font-medium">Hours</th>
                <th className="px-2 py-1 text-right font-medium">Amount</th>
                {/* Action column always present so the per-task delete works
                    on every task row — including tasks shown inside a zone
                    via a referenced template. The delete targets the
                    underlying template_task by id, so a click here removes
                    the task from wherever it lives. */}
                <th className="px-2 py-1 text-center font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task: any) => (
                <tr key={task.id} className="hover:bg-blue-50/50">
                  <td className="px-2 py-1 font-mono text-muted-foreground">{task.code || '-'}</td>
                  <td className="px-2 py-1">{task.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{task.defaultBudgetHours != null ? `${Number(task.defaultBudgetHours)}` : '-'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{task.defaultBudgetAmount != null ? `${'\u20AA'}${Number(task.defaultBudgetAmount).toLocaleString()}` : '-'}</td>
                  <td className="px-2 py-1 text-center">
                    {/* Red at rest (not muted) so the per-task delete reads
                        as an action button instead of disappearing into the
                        row chrome. Always rendered (no readOnly gate) so the
                        action is available on every deliverable's task row. */}
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingDelete({ id: task.id, name: task.name }); }}
                      title="Remove task"
                      className="rounded p-1 text-red-500 hover:bg-red-100 hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Styled confirmation — matches the app's design instead of the
          browser's native confirm() popup. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) deleteTask.mutate(pendingDelete.id); }}
        variant="danger"
        title="Remove task?"
        description={pendingDelete ? `Remove "${pendingDelete.name}" from this deliverable? This cannot be undone.` : ''}
        confirmLabel="Remove"
        isLoading={deleteTask.isPending}
      />
    </div>
  );
}
