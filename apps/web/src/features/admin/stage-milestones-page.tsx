/**
 * Admin catalog for Project Stage Milestones — the columns on the
 * Status Board (URS Production, Architectural Review, Stage 1, …).
 *
 * Single-page CRUD: list + inline add row + inline edit on each row +
 * hard delete (with confirm). Sort order is the column order on the
 * board; admins move columns left/right by editing sortOrder.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, ArrowLeft } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { EmptyState } from '@/components/shared/empty-state';
import { Flag } from 'lucide-react';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { useConfirm } from '@/components/shared/confirm-dialog';

interface Milestone {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
}

const inputCls = 'w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none';

export function StageMilestonesPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
  const { data: milestones = [], isLoading } = useQuery<Milestone[]>({
    queryKey: ['project-stage-milestones'],
    queryFn: () =>
      client.get('/project-status-board/milestones').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project-stage-milestones'] });
    queryClient.invalidateQueries({ queryKey: ['project-status-board'] });
  };

  const create = useMutation({
    mutationFn: (data: { code: string; name: string; description?: string; sortOrder?: number }) =>
      client.post('/project-status-board/milestones', data).then((r) => r.data),
    onSuccess: () => {
      notify.success('Milestone added');
      invalidate();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add milestone'),
  });

  const update = useMutation({
    mutationFn: ({ id, ...data }: Partial<Milestone> & { id: number }) =>
      client.patch(`/project-status-board/milestones/${id}`, data).then((r) => r.data),
    onSuccess: () => {
      // Task calls for notify.success on every edit mutation. This
      // page's inline-blur-to-save UX means the toast can fire on
      // every field commit — brief text keeps it out of the way.
      notify.success('Milestone updated');
      invalidate();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update milestone'),
  });

  const remove = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/project-status-board/milestones/${id}`).then((r) => r.data),
    onSuccess: () => {
      notify.success('Milestone deleted');
      invalidate();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete milestone'),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link
          to="/admin"
          className="rounded-md p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Back to Admin"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <PageHeader
          title="Project Stage Milestones"
          description="The columns that appear on the Status Board. Sort order = left-to-right order on the board. Deactivate to hide a column without losing per-project history."
        />
      </div>

      <NewMilestoneRow onAdd={(data) => create.mutate(data)} submitting={create.isPending} />

      {/* Empty-state hoisted out of the table (was a <tr><td colSpan>
          inside tbody). Rendered above the table's own scroll box
          when there are no milestones AND we're not loading. */}
      {!isLoading && milestones.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No milestones yet"
          description="Add one above to create a Status Board column."
        />
      ) : (
        <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left w-20">Sort</th>
                <th className="px-3 py-2 text-left w-[160px]">Code</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-center w-[90px]">Active</th>
                <th className="px-3 py-2 text-right w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {isLoading ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">Loading…</td></tr>
              ) : (
                milestones.map((m) => (
                  <MilestoneRow
                    key={m.id}
                    m={m}
                    onPatch={(patch) => update.mutate({ id: m.id, ...patch })}
                    onDelete={async () => {
                      if (await confirm(`Delete "${m.name}"? Per-project statuses for this milestone will be lost.`)) {
                        remove.mutate(m.id);
                      }
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewMilestoneRow({
  onAdd,
  submitting,
}: {
  onAdd: (data: { code: string; name: string; description?: string; sortOrder?: number }) => void;
  submitting: boolean;
}) {
  const [form, setForm] = useState({ code: '', name: '', description: '', sortOrder: '' });

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-800/40 p-3">
      <div className="grid grid-cols-[80px_160px_1fr_1fr_auto] gap-2 items-center">
        <input
          type="number"
          value={form.sortOrder}
          placeholder="Sort"
          onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
          className={inputCls}
        />
        <input
          type="text"
          value={form.code}
          placeholder='code (e.g. "stage_2")'
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          className={inputCls}
        />
        <input
          type="text"
          value={form.name}
          placeholder='Display name (e.g. "Stage 2")'
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className={inputCls}
        />
        <input
          type="text"
          value={form.description}
          placeholder="Optional description / tooltip"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className={inputCls}
        />
        <button
          onClick={() => {
            if (!form.code.trim() || !form.name.trim()) {
              notify.warning('Code and name are required');
              return;
            }
            onAdd({
              code: form.code,
              name: form.name,
              description: form.description || undefined,
              sortOrder: form.sortOrder ? Number(form.sortOrder) : 0,
            });
            setForm({ code: '', name: '', description: '', sortOrder: '' });
          }}
          disabled={submitting}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}

function MilestoneRow({
  m,
  onPatch,
  onDelete,
}: {
  m: Milestone;
  onPatch: (patch: Partial<Milestone>) => void;
  onDelete: () => void;
}) {
  // Local form mirrors the row so users can edit without round-tripping
  // every keystroke. Commit on blur (same pattern as the Project Info
  // tab and Seniority History rows).
  const [draft, setDraft] = useState({
    sortOrder: String(m.sortOrder),
    code: m.code,
    name: m.name,
    description: m.description ?? '',
  });

  const commit = (field: keyof typeof draft, parser: (v: string) => any = (v) => v) => {
    const next = parser(draft[field]);
    const cur = field === 'sortOrder' ? m.sortOrder : (m as any)[field] ?? '';
    if (next === cur) return;
    onPatch({ [field]: field === 'sortOrder' ? Number(next) : next });
  };

  return (
    <tr className={cn(m.isActive ? '' : 'opacity-50')}>
      <td className="px-3 py-2">
        <input
          type="number"
          value={draft.sortOrder}
          onChange={(e) => setDraft((d) => ({ ...d, sortOrder: e.target.value }))}
          onBlur={() => commit('sortOrder')}
          className={cn(inputCls, 'w-16')}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={draft.code}
          onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
          onBlur={() => commit('code')}
          className={cn(inputCls, 'font-mono text-[11px]')}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={() => commit('name')}
          className={inputCls}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          onBlur={() => commit('description')}
          className={inputCls}
          placeholder="—"
        />
      </td>
      <td className="px-3 py-2 text-center">
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={m.isActive}
            onChange={(e) => onPatch({ isActive: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
          />
        </label>
      </td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={onDelete}
          className="text-slate-400 dark:text-slate-500 hover:text-red-600 rounded p-1.5 hover:bg-red-50"
          title="Delete milestone"
          aria-label="Delete milestone"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}
