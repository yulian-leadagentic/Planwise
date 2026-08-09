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
 *
 * Core-task mandatory fields (Ops backlog #2, 2026-08-08): a
 * non-personal task must carry serviceTypeId, zoneId, a Deliverable
 * (projectDeliverableId or deliverableTemplateId), and an explicit
 * Review flag (requiresReview). Inline errors below each missing
 * field; the backend also enforces this via a structured 400.
 */
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

interface ProjectOption { id: number; name: string; number?: string }
interface ZoneOption { id: number; name: string }
interface ServiceTypeOption { id: number; name: string; code?: string }
interface DeliverableOption { id: number; name: string; serviceId?: number }

const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';
const inputErrCls = 'w-full px-3 py-2 rounded-lg border border-red-400 dark:border-red-600 text-sm text-slate-700 dark:text-slate-200 focus:border-red-500 focus:outline-none';

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
    serviceTypeId: '',
    // Deliverable — the user picks EITHER a project-owned deliverable
    // (projectDeliverableId) or a template (deliverableTemplateId).
    // We render one combined dropdown with a prefix on the value so
    // the submit path knows which key to fill.
    deliverableRef: '',
    // requiresReview must be explicitly set — no default. Empty string
    // = unpicked, "yes" / "no" translate to true / false.
    requiresReview: '' as '' | 'yes' | 'no',
    code: '',
    name: '',
    description: '',
    priority: 'medium',
    budgetHours: '',
    estimatedStartDate: '',
  });
  // Inline field-level errors from the backend's structured 400.
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());

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

  // Zones — narrowed by selected project. Empty list when no project.
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

  // Service types — catalog-wide, small list. Fetched once regardless of project.
  const { data: services = [] } = useQuery<ServiceTypeOption[]>({
    queryKey: ['service-types', 'all'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/service-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });

  // Deliverables — narrowed by project. Union of project-owned + template list.
  const { data: projectDeliverables = [] } = useQuery<DeliverableOption[]>({
    queryKey: ['project-deliverables', form.projectId],
    enabled: !!form.projectId,
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get('/project-deliverables', { params: { projectId: form.projectId } }).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });
  const { data: templates = [] } = useQuery<DeliverableOption[]>({
    queryKey: ['deliverable-templates'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/templates', { params: { type: 'task_list' } }).then((r) => {
        const d = r.data?.data ?? r.data;
        const list = Array.isArray(d) ? d : (d?.data ?? []);
        return (list as any[]).filter((t) => t.code !== '__TASK_CATALOG__');
      }),
  });
  const deliverableOptions = useMemo(() => {
    // Project-owned first (authoritative), then any templates not already covered.
    const pd = projectDeliverables.map((d) => ({ value: `pd:${d.id}`, label: d.name, group: 'Project' }));
    const tp = templates.map((t) => ({ value: `tpl:${t.id}`, label: t.name, group: 'Template' }));
    return [...pd, ...tp];
  }, [projectDeliverables, templates]);

  const create = useMutation({
    mutationFn: () => {
      const [kind, rawId] = form.deliverableRef.split(':');
      const idNum = rawId ? Number(rawId) : undefined;
      return tasksApi.create({
        projectId: Number(form.projectId),
        zoneId: form.zoneId ? Number(form.zoneId) : undefined,
        serviceTypeId: form.serviceTypeId ? Number(form.serviceTypeId) : undefined,
        projectDeliverableId: kind === 'pd' ? idNum : undefined,
        deliverableTemplateId: kind === 'tpl' ? idNum : undefined,
        requiresReview: form.requiresReview === 'yes' ? true : form.requiresReview === 'no' ? false : undefined,
        code: form.code.trim() || `T-${Date.now()}`,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        priority: form.priority,
        budgetHours: form.budgetHours ? Number(form.budgetHours) : undefined,
        estimatedStartDate: form.estimatedStartDate || undefined,
      } as any);
    },
    onSuccess: (resp: any) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
      notify.success('Task created', { code: 'TASK-CREATE-200' });
      const id = resp?.data?.id ?? resp?.id;
      if (id && onCreated) onCreated(id);
      onClose();
    },
    onError: (err: any) => {
      // Structured 400 from the backend's core-task guardrail lists
      // missing fields — surface them inline instead of blowing up
      // with a generic toast.
      const body = err?.response?.data;
      const missing = Array.isArray(body?.missing) ? body.missing : null;
      if (body?.error === 'missing_required_fields' && missing) {
        setFieldErrors(new Set(missing));
        notify.warning(body.message ?? 'Please fill the required fields', { code: 'TASK-CREATE-400' });
        return;
      }
      notify.apiError(err, 'Failed to create task');
    },
  });

  const validateLocal = (): Set<string> => {
    const errs = new Set<string>();
    if (!form.projectId) errs.add('projectId');
    if (!form.name.trim()) errs.add('name');
    if (!form.zoneId) errs.add('zoneId');
    if (!form.serviceTypeId) errs.add('serviceTypeId');
    if (!form.deliverableRef) errs.add('projectDeliverableId');
    if (form.requiresReview === '') errs.add('requiresReview');
    return errs;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateLocal();
    if (errs.size > 0) {
      setFieldErrors(errs);
      notify.warning('Fill the required fields to create a task', { code: 'TASK-CREATE-400' });
      return;
    }
    setFieldErrors(new Set());
    create.mutate();
  };

  const hasErr = (k: string) => fieldErrors.has(k);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[620px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">New Task</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4" aria-hidden="true" />
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
              onChange={(e) => { setForm((f) => ({ ...f, projectId: e.target.value, zoneId: '', deliverableRef: '' })); setFieldErrors((s) => { const n = new Set(s); n.delete('projectId'); return n; }); }}
              className={hasErr('projectId') ? inputErrCls : inputCls}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number ? `${p.number} · ` : ''}{p.name}
                </option>
              ))}
            </select>
            {hasErr('projectId') && <p className="mt-1 text-[11px] text-red-600">Project is required.</p>}
          </div>

          {/* Zone — required for core tasks. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Zone <span className="text-red-500">*</span>
            </label>
            <select
              value={form.zoneId}
              onChange={(e) => { setForm((f) => ({ ...f, zoneId: e.target.value })); setFieldErrors((s) => { const n = new Set(s); n.delete('zoneId'); return n; }); }}
              className={hasErr('zoneId') ? inputErrCls : inputCls}
              disabled={!form.projectId}
            >
              <option value="">— Select zone —</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
            {hasErr('zoneId') && <p className="mt-1 text-[11px] text-red-600">Zone is required for core tasks.</p>}
          </div>

          {/* Service — required for core tasks. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Service <span className="text-red-500">*</span>
            </label>
            <select
              value={form.serviceTypeId}
              onChange={(e) => { setForm((f) => ({ ...f, serviceTypeId: e.target.value })); setFieldErrors((s) => { const n = new Set(s); n.delete('serviceTypeId'); return n; }); }}
              className={hasErr('serviceTypeId') ? inputErrCls : inputCls}
            >
              <option value="">— Select service —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>
              ))}
            </select>
            {hasErr('serviceTypeId') && <p className="mt-1 text-[11px] text-red-600">Service is required for core tasks.</p>}
          </div>

          {/* Deliverable — required. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Deliverable <span className="text-red-500">*</span>
            </label>
            <select
              value={form.deliverableRef}
              onChange={(e) => { setForm((f) => ({ ...f, deliverableRef: e.target.value })); setFieldErrors((s) => { const n = new Set(s); n.delete('projectDeliverableId'); return n; }); }}
              className={hasErr('projectDeliverableId') ? inputErrCls : inputCls}
              disabled={!form.projectId}
            >
              <option value="">— Select deliverable —</option>
              {deliverableOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.group} · {o.label}</option>
              ))}
            </select>
            {hasErr('projectDeliverableId') && <p className="mt-1 text-[11px] text-red-600">Deliverable (project or template) is required for core tasks.</p>}
          </div>

          {/* Review flag — required to be explicitly set. */}
          <div>
            <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
              Requires review? <span className="text-red-500">*</span>
            </label>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
              <button
                type="button"
                onClick={() => { setForm((f) => ({ ...f, requiresReview: 'yes' })); setFieldErrors((s) => { const n = new Set(s); n.delete('requiresReview'); return n; }); }}
                className={cn('px-3 py-1.5 rounded-md text-[12px] font-semibold', form.requiresReview === 'yes' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => { setForm((f) => ({ ...f, requiresReview: 'no' })); setFieldErrors((s) => { const n = new Set(s); n.delete('requiresReview'); return n; }); }}
                className={cn('px-3 py-1.5 rounded-md text-[12px] font-semibold', form.requiresReview === 'no' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100')}
              >
                No
              </button>
            </div>
            {hasErr('requiresReview') && <p className="mt-1 text-[11px] text-red-600">Pick whether this task needs a review step.</p>}
          </div>

          {/* Name + Code */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
                Task Name <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setFieldErrors((s) => { const n = new Set(s); n.delete('name'); return n; }); }}
                className={hasErr('name') ? inputErrCls : inputCls}
                autoFocus
              />
              {hasErr('name') && <p className="mt-1 text-[11px] text-red-600">Task name is required.</p>}
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
