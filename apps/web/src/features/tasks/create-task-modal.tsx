/**
 * Minimal "New Task" modal — opened from the Tasks page's header button.
 *
 * Scope note: in the M2 backlog the user asked for tasks "with or
 * without a project link". The current Task schema has projectId as
 * NOT NULL, so a fully-standalone task isn't possible without a
 * migration (plus cost calcs, planning, etc. all assume non-null
 * project). For now this modal makes the project picker REQUIRED and
 * leaves zone optional — that already covers the "project task that
 * isn't tied to a spatial zone" case (the planning grid groups those
 * under a Project Root row). The truly-standalone case is deferred to
 * a later sprint with a small schema change.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

interface ProjectOption { id: number; name: string; number?: string }
interface ZoneOption { id: number; name: string }

const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';

export function CreateTaskModal({
  onClose,
  onCreated,
  preselectProjectId,
}: {
  onClose: () => void;
  onCreated?: (id: number) => void;
  preselectProjectId?: number;
}) {
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    projectId: preselectProjectId ? String(preselectProjectId) : '',
    zoneId: '',
    code: '',
    name: '',
    description: '',
    priority: 'medium',
    budgetHours: '',
    estimatedStartDate: '',
  });

  // Project list — required field. We don't apply server-side filtering
  // here; the user can scroll or type-narrow with their browser.
  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects', 'lite'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/projects?perPage=200&fields=lite').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });

  // Zones — narrowed by selected project. Empty list when no project,
  // so the "Project Root" placeholder option is the only choice.
  const { data: zones = [] } = useQuery<ZoneOption[]>({
    queryKey: ['zones', 'for-task-create', form.projectId],
    enabled: !!form.projectId,
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get(`/zones?projectId=${form.projectId}&perPage=500`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });

  const create = useMutation({
    mutationFn: () =>
      tasksApi.create({
        // tasksApi.create's payload typing requires zoneId; using `any`
        // until we widen the typing for project-root tasks. The backend
        // DTO already accepts a null/undefined zoneId.
        projectId: Number(form.projectId),
        zoneId: form.zoneId ? Number(form.zoneId) : undefined,
        code: form.code.trim() || `T-${Date.now()}`,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        priority: form.priority,
        budgetHours: form.budgetHours ? Number(form.budgetHours) : undefined,
        estimatedStartDate: form.estimatedStartDate || undefined,
      } as any),
    onSuccess: (resp: any) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Task created', { code: 'TASK-CREATE-200' });
      const id = resp?.data?.id ?? resp?.id;
      if (id && onCreated) onCreated(id);
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.projectId) {
      notify.warning('Pick a project — tasks must belong to one for now.', { code: 'TASK-CREATE-400' });
      return;
    }
    if (!form.name.trim()) {
      notify.warning('Task name is required', { code: 'TASK-CREATE-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">New Task</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4">
          {/* Project — required. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Project <span className="text-red-500">*</span>
            </label>
            <select
              value={form.projectId}
              onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value, zoneId: '' }))}
              className={inputCls}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number ? `${p.number} · ` : ''}{p.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              Standalone tasks (without a project link) require a schema change — coming in a later sprint.
            </p>
          </div>

          {/* Zone — optional. Empty = "project root" task. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Zone <span className="text-slate-400 dark:text-slate-500 font-normal">(optional)</span>
            </label>
            <select
              value={form.zoneId}
              onChange={(e) => setForm((f) => ({ ...f, zoneId: e.target.value }))}
              className={inputCls}
              disabled={!form.projectId}
            >
              <option value="">Project Root (no zone)</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>

          {/* Name + Code */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
                Task Name <span className="text-red-500">*</span>
              </label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} autoFocus />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Code</label>
              <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className={inputCls} placeholder="auto" />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              className={cn(inputCls, 'resize-none')}
            />
          </div>

          {/* Priority + Estimated start + Budget hours */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Priority</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} className={inputCls}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Est. Start</label>
              <input type="date" value={form.estimatedStartDate} onChange={(e) => setForm((f) => ({ ...f, estimatedStartDate: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Budget (h)</label>
              <input type="number" min="0" step="0.5" value={form.budgetHours} onChange={(e) => setForm((f) => ({ ...f, budgetHours: e.target.value }))} className={inputCls} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg">
              Cancel
            </button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
