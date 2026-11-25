import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  deleteBlockedReason,
  isTemplateArchived,
  type TemplateListView,
} from './template-archive';

/**
 * PR-053 (QA6, 2026-11-25) — shared Active / Archived toggle and row
 * actions for the Deliverable Templates and Zone Hierarchy pages.
 */

export function TemplateArchiveToggle({
  value,
  onChange,
}: {
  value: TemplateListView;
  onChange: (v: TemplateListView) => void;
}) {
  const item = (v: TemplateListView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === v}
      onClick={() => onChange(v)}
      className={cn(
        'rounded-[7px] px-3 py-1.5 text-[13px] font-semibold transition-all duration-150',
        value === v
          ? 'border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
          : 'border border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="tablist"
      aria-label="Template status"
      className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800"
    >
      {item('active', 'Active')}
      {item('archived', 'Archived')}
    </div>
  );
}

export function ArchivedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] bg-slate-100 px-2 py-0.5 text-[11px] font-bold tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <Archive className="h-3 w-3" aria-hidden="true" />
      Archived
    </span>
  );
}

/**
 * Archive / restore / delete mutations. Every template list is
 * invalidated on success so the pickers (which share the active list
 * keys) drop or regain the template at once.
 */
export function useTemplateArchiveActions(label: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['templates'] });
    queryClient.invalidateQueries({ queryKey: ['deliverable-templates'] });
    queryClient.invalidateQueries({ queryKey: ['/templates?type=task_list'] });
  };
  const archive = useMutation({
    mutationFn: (id: number) => client.post(`/templates/${id}/archive`).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success(`${label} archived`, { code: 'TPL-ARCHIVE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to archive'),
  });
  const restore = useMutation({
    mutationFn: (id: number) => client.post(`/templates/${id}/restore`).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success(`${label} restored`, { code: 'TPL-RESTORE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to restore'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      refresh();
      notify.success(`${label} deleted`, { code: 'TPL-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });
  return { archive, restore, remove };
}

const iconBtn =
  'inline-flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200';

/** Archive (active rows) or Restore (archived rows), then Delete. */
export function TemplateRowActions({
  template,
  actions,
}: {
  template: { id: number; name: string; usageCount?: number | null; usage?: any; archivedAt?: string | null };
  actions: ReturnType<typeof useTemplateArchiveActions>;
}) {
  const confirm = useConfirm();
  const archived = isTemplateArchived(template);
  const blocked = deleteBlockedReason(template);
  const busy = actions.archive.isPending || actions.restore.isPending || actions.remove.isPending;

  return (
    <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {archived ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => actions.restore.mutate(template.id)}
          className={iconBtn}
          title="Restore: show it in the pickers again"
          aria-label={`Restore ${template.name}`}
        >
          <ArchiveRestore className="h-[14px] w-[14px]" />
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (
              await confirm(
                `Archive "${template.name}"? It is hidden from every picker and stays as is in projects and templates that already use it. You can restore it from Archived.`,
              )
            ) {
              actions.archive.mutate(template.id);
            }
          }}
          className={iconBtn}
          title="Archive: hide from pickers, keep where it is used"
          aria-label={`Archive ${template.name}`}
        >
          <Archive className="h-[14px] w-[14px]" />
        </button>
      )}
      {/* Not `disabled` when in use: a disabled button shows no tooltip
          in every browser, so the click explains instead. */}
      <button
        type="button"
        disabled={busy}
        aria-disabled={blocked != null}
        onClick={async () => {
          if (blocked) {
            notify.info(blocked, { code: 'TEMPLATE_IN_USE' });
            return;
          }
          if (await confirm(`Delete "${template.name}"? This cannot be undone.`)) {
            actions.remove.mutate(template.id);
          }
        }}
        className={cn(
          iconBtn,
          blocked
            ? 'opacity-40'
            : 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400',
        )}
        title={blocked ?? 'Delete'}
        aria-label={blocked ? `${template.name}: ${blocked}` : `Delete ${template.name}`}
      >
        <Trash2 className="h-[14px] w-[14px]" />
      </button>
    </div>
  );
}
