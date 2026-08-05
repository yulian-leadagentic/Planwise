import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';
import { queryKeys } from '@/lib/query-keys';

/**
 * Personal-task creation dialog (Tier D #1, 2026-06-30).
 *
 * Personal tasks belong to the individual employee — not any project,
 * zone, service, or deliverable. This modal is the entry point on the
 * My Tasks page and is intentionally lean: name (required), optional
 * description + due date + est. hours + review flag. The backend's
 * create() path already relaxes the project-required validation when
 * isPersonal=true; we just POST /tasks with that flag.
 */
export function PersonalTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endDate, setEndDate] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  // Optional project context — cascading pickers. Personal tasks don't
  // REQUIRE a project link; if the user picks one, zones + deliverables
  // filter to that project. (Client feedback 2026-08-02.)
  const [projectId, setProjectId] = useState<number | ''>('');
  const [zoneId, setZoneId] = useState<number | ''>('');
  const [projectDeliverableId, setProjectDeliverableId] = useState<number | ''>('');
  // Personal tasks default to NO review — per client spec.
  const [saving, setSaving] = useState(false);

  // Projects the user can pick from. Same source the Time-log dialog uses.
  const { data: projectsResp } = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => client.get('/projects', { params: { perPage: 200 } }).then((r) => r.data),
  });
  const projects: any[] = Array.isArray(projectsResp?.data) ? projectsResp.data : [];

  // Zones for the currently-picked project (cascading).
  const { data: zonesResp } = useQuery({
    queryKey: ['project-zones', projectId],
    enabled: !!projectId,
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
  });
  const zones: any[] = Array.isArray(zonesResp?.zones) ? zonesResp.zones : [];

  // Deliverables for the currently-picked project.
  const { data: deliverablesResp } = useQuery({
    queryKey: ['project-deliverables', projectId],
    enabled: !!projectId,
    queryFn: () => client.get('/project-deliverables', { params: { projectId } }).then((r) => r.data?.data ?? r.data),
  });
  const deliverables: any[] = Array.isArray(deliverablesResp) ? deliverablesResp : [];

  // Due date is required for personal tasks (client feedback).
  const canSave = name.trim().length > 0 && !!endDate && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await tasksApi.create({
        code: `PERSONAL-${Date.now().toString(36).toUpperCase()}`,
        name: name.trim(),
        description: description.trim() || undefined,
        endDate,
        budgetHours: budgetHours ? Number(budgetHours) : undefined,
        projectId: projectId || undefined,
        zoneId: zoneId || undefined,
        projectDeliverableId: projectDeliverableId || undefined,
        isPersonal: true,
        // Personal tasks skip the review step by default.
        requiresReview: false,
      } as any);
      notify.success('Personal task created', { code: 'TASK-CREATE-200' });
      onCreated();
    } catch (err: any) {
      notify.apiError(err, 'Failed to create personal task');
      setSaving(false);
    }
  };

  // Clear cascading pickers when project changes.
  const handleProjectChange = (v: string) => {
    setProjectId(v ? Number(v) : '');
    setZoneId('');
    setProjectDeliverableId('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[500px] max-w-[92vw] max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">New personal task</h2>
            <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">Just for you. Project / zone / deliverable are optional; Due date is required.</p>
          </div>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="p-5 space-y-4"
        >
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Task name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Review latest drawings"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional details…"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
                Due date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Est. hours</label>
              <input
                type="number"
                min="0"
                step="0.25"
                value={budgetHours}
                onChange={(e) => setBudgetHours(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          {/* Optional project context — cascading. Zone + Deliverable
              pickers are disabled until a project is chosen. */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-3">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Optional project context
            </div>
            <div>
              <label className="text-[12px] text-slate-600 dark:text-slate-300 mb-1 block">Project</label>
              <select
                value={projectId}
                onChange={(e) => handleProjectChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
              >
                <option value="">— None —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.number ? ` (${p.number})` : ''}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[12px] text-slate-600 dark:text-slate-300 mb-1 block">Zone</label>
                <select
                  value={zoneId}
                  disabled={!projectId}
                  onChange={(e) => setZoneId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— None —</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[12px] text-slate-600 dark:text-slate-300 mb-1 block">Deliverable</label>
                <select
                  value={projectDeliverableId}
                  disabled={!projectId}
                  onChange={(e) => setProjectDeliverableId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— None —</option>
                  {deliverables.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[13px] font-semibold px-4 py-2 rounded-lg"
            >
              {saving ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
