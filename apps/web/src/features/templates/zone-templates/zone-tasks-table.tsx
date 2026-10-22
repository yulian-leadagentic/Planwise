import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Lock } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

// ---------------------------------------------------------------------------
// Zone Tasks Table (compact, displayed under zone node)
// ---------------------------------------------------------------------------

export function ZoneTasksTable({
  tasks,
  templateId,
}: {
  tasks: any[];
  templateId: number;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/zone-tasks/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  if (tasks.length === 0) return null;

  return (
    <div className="mt-1 mb-1 ml-7">
      <div className="text-xs font-medium text-muted-foreground mb-0.5">Tasks:</div>
      <table className="w-full text-xs border border-border rounded-md overflow-hidden">
        <thead>
          <tr className="bg-muted/50 border-b border-border">
            <th className="px-2 py-1 text-left font-medium">Code</th>
            <th className="px-2 py-1 text-left font-medium">Name</th>
            <th className="px-2 py-1 text-right font-medium">Hours</th>
            <th className="px-2 py-1 text-right font-medium">Amount</th>
            <th className="px-2 py-1 text-center font-medium w-8"></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task: any) => (
            <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="px-2 py-1 font-mono text-muted-foreground">{task.code || '-'}</td>
              <td className="px-2 py-1 font-medium">
                {/* DN-ext (2026-10-22) — the row's name is already
                    read-only here (no inline edit in the Zone Template
                    editor); add a small Catalog badge so the user can
                    tell at a glance which rows are catalog-linked and
                    which are ad-hoc. Compact variant to fit the
                    1-line zone-tasks row (text-[10px]). */}
                <div className="flex items-center gap-1">
                  <span>{task.name}</span>
                  {task.catalogTask && (
                    <span
                      className="inline-flex items-center gap-0.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 px-1 py-0.5 text-[9px] font-bold tracking-[0.05em] text-slate-500 dark:text-slate-400"
                      title="ערוך ב-Task Catalog · Edit in Task Catalog"
                      aria-label="Linked to Task Catalog"
                    >
                      <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                      Catalog
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {task.defaultBudgetHours != null ? `${Number(task.defaultBudgetHours).toFixed(0)}h` : '-'}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {task.defaultBudgetAmount != null ? `\u20AA${Number(task.defaultBudgetAmount).toLocaleString()}` : '-'}
              </td>
              <td className="px-2 py-1 text-center">
                <button
                  onClick={async () => { if (await confirm(`Remove task "${task.name}"?`)) deleteMutation.mutate(task.id); }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                  title="Remove task"
                >
                  <X className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
