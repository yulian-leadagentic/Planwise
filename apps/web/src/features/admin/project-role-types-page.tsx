import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, Save, X, Briefcase, Lock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import client from '@/api/client';
import { useConfirm } from '@/components/shared/confirm-dialog';

// Project Role Types — catalog of roles a party can hold on a project
// (Customer, Supplier, Participant, Architect, …). Mirrors the existing
// Partner Role Types screen but for project-side assignments. The 6
// seeded rows are protected from delete; admins can add custom roles.

interface ProjectRoleType {
  id: number;
  code: string;
  name: string;
  description: string | null;
  allowedPartnerKind: 'person' | 'organization';
  requiredPartnerRoleCode: string | null;
  /** M4a.3 — Multi-select of Profession ids ("Job Titles"). null/empty = no constraint. */
  requiredProfessionIds: number[] | null;
  isPrimaryRequired: boolean;
  sortOrder: number;
  isSystem: boolean;
}

interface PartnerRoleType {
  id: number;
  code: string;
  name: string;
  /** M4a.3 — Filters this role's visibility in the project-role form to a kind. */
  appliesToKind: 'person' | 'organization' | 'any';
}

interface Profession {
  id: number;
  name: string;
  sortOrder: number;
}

const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';
// 'any' removed in M4a.3 — every project role attaches to a single
// kind (person OR organization).
const KIND_OPTIONS: Array<'person' | 'organization'> = ['person', 'organization'];

export function ProjectRoleTypesPage() {
  const confirm = useConfirm();
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('admin/project-role-types', 'write');
  const canDelete = isAdmin || can('admin/project-role-types', 'delete');
  const queryClient = useQueryClient();
  const scrollRef = useStickyHScroll();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);

  const { data: types = [], isLoading } = useQuery<ProjectRoleType[]>({
    queryKey: ['project-role-types'],
    queryFn: () =>
      client.get('/admin/project-role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const remove = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/project-role-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-role-types'] });
      notify.success('Project role type deleted', { code: 'PRT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Role Types"
        description="Catalog of roles a partner can hold on a project (Customer, Supplier, Architect, …). System roles can be renamed but not deleted."
        actions={canWrite && editingId === null ? (
          <button
            onClick={() => setEditingId('new')}
            title="Define a new role a partner can hold on a project (e.g. Lead Architect, BIM Manager, Site Engineer). Each project role gets its own section on the project Team tab with an Add button. Use the 'Allowed kind' + 'Required partner-role' fields to constrain who can be picked."
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Add Project Role
          </button>
        ) : null}
      />

      {/* Explainer */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-blue-50/40 p-3 text-[12px] text-slate-700 dark:text-slate-200 space-y-2">
        <p className="font-semibold text-slate-800 dark:text-slate-100">What does each row do?</p>
        <p>
          A project role defines <strong>what a partner does on a project</strong>. The 4 system roles
          (Customer, Supplier, Participant, plus optional ones) cover the common cases; admins
          can add custom roles like <em>Lead Architect</em>, <em>QA Inspector</em>, etc.
        </p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>Allowed kind</strong> — restricts which party kind (person / org) can hold this role.</li>
          <li><strong>Required partner-role</strong> — party must also hold this role globally (e.g. project Customer requires partner-role <code>customer</code>).</li>
          <li><strong>Primary required</strong> — exactly one party holds the role as primary on a project (e.g. one primary Customer).</li>
        </ul>
      </div>

      {isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : (
        <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2 text-left font-semibold w-32">Code</th>
                <th className="px-4 py-2 text-left font-semibold w-44">Name</th>
                <th className="px-4 py-2 text-left font-semibold">Rules</th>
                <th className="px-4 py-2 text-center font-semibold w-20">Type</th>
                <th className="px-4 py-2 text-right font-semibold w-32"></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && <EditRow onClose={() => setEditingId(null)} />}
              {types.map((t) =>
                editingId === t.id
                  ? <EditRow key={t.id} type={t} onClose={() => setEditingId(null)} />
                  : (
                    <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-4 py-2.5 font-mono text-[12px] text-slate-600 dark:text-slate-300">{t.code}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{t.name}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{t.allowedPartnerKind}</span>
                          {t.requiredPartnerRoleCode && (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                              role: {t.requiredPartnerRoleCode}
                            </span>
                          )}
                          {t.requiredProfessionIds && t.requiredProfessionIds.length > 0 && (
                            <span
                              className="rounded-full bg-violet-50 px-2 py-0.5 font-semibold text-violet-700"
                              title={`Job titles required: ${t.requiredProfessionIds.length} selected`}
                            >
                              {t.requiredProfessionIds.length} job title{t.requiredProfessionIds.length > 1 ? 's' : ''}
                            </span>
                          )}
                          {t.isPrimaryRequired && (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                              required on every project
                            </span>
                          )}
                        </div>
                        {t.description && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{t.description}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {t.isSystem ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                            <Lock className="h-2.5 w-2.5" /> System
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300">Custom</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canWrite && (
                          <button
                            onClick={() => setEditingId(t.id)}
                            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && !t.isSystem && (
                          <button
                            onClick={async () => {
                              if (await confirm(`Delete project role "${t.name}"?`)) remove.mutate(t.id);
                            }}
                            className="p-1.5 rounded hover:bg-red-50 text-slate-400 dark:text-slate-500 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ),
              )}
              {!isLoading && types.length === 0 && editingId !== 'new' && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400 dark:text-slate-500 text-sm">
                  <Briefcase className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No project role types yet. Add one to get started.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EditRow({ type, onClose }: { type?: ProjectRoleType; onClose: () => void }) {
  const isNew = !type;
  const queryClient = useQueryClient();

  // Partner role catalog. We filter visibility to roles whose
  // appliesToKind matches the form's selected kind (employee shows
  // only when kind=person, supplier only when kind=organization, etc.).
  const { data: partnerRoleTypes = [] } = useQuery<PartnerRoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  // Job Title (Profession) catalog.
  const { data: professions = [] } = useQuery<Profession[]>({
    queryKey: ['professions'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/professions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    allowedPartnerKind: (type?.allowedPartnerKind ?? 'person') as 'person' | 'organization',
    requiredPartnerRoleCode: type?.requiredPartnerRoleCode ?? '',
    requiredProfessionIds: (type?.requiredProfessionIds ?? []) as number[],
    isPrimaryRequired: type?.isPrimaryRequired ?? false,
    sortOrder: type?.sortOrder ?? 0,
  });

  // Filter the Required partner-role dropdown to roles that can attach to
  // the chosen kind (employee shows when kind=person, supplier shows when
  // kind=organization, etc.). 'any' partner-roles always show.
  const eligibleRoles = partnerRoleTypes.filter(
    (rt) => rt.appliesToKind === 'any' || rt.appliesToKind === form.allowedPartnerKind,
  );
  // If the user previously selected a role that becomes ineligible after
  // changing the kind, clear it so we don't post a stale value.
  useEffect(() => {
    if (
      form.requiredPartnerRoleCode &&
      !eligibleRoles.some((r) => r.code === form.requiredPartnerRoleCode)
    ) {
      setForm((f) => ({ ...f, requiredPartnerRoleCode: '' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.allowedPartnerKind, partnerRoleTypes]);

  const toggleProfession = (id: number) => {
    setForm((f) => ({
      ...f,
      requiredProfessionIds: f.requiredProfessionIds.includes(id)
        ? f.requiredProfessionIds.filter((x) => x !== id)
        : [...f.requiredProfessionIds, id],
    }));
  };

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        allowedPartnerKind: form.allowedPartnerKind,
        requiredPartnerRoleCode: form.requiredPartnerRoleCode || null,
        requiredProfessionIds:
          form.requiredProfessionIds.length > 0 ? form.requiredProfessionIds : null,
        isPrimaryRequired: form.isPrimaryRequired,
        sortOrder: form.sortOrder,
      };
      if (isNew) body.code = form.code.trim().toLowerCase();
      else if (!type?.isSystem) body.code = form.code.trim().toLowerCase();
      return isNew
        ? client.post('/admin/project-role-types', body).then((r) => r.data)
        : client.patch(`/admin/project-role-types/${type!.id}`, body).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-role-types'] });
      notify.success(isNew ? 'Project role created' : 'Project role updated', { code: 'PRT-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save'),
  });

  return (
    <tr className="border-t border-slate-100 dark:border-slate-800 bg-blue-50/30">
      <td className="px-4 py-2">
        <input
          value={form.code}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          disabled={!isNew && type?.isSystem}
          placeholder="e.g. lead_architect"
          className={cn(inputClass, 'font-mono text-[12px] disabled:bg-slate-100 disabled:cursor-not-allowed')}
        />
      </td>
      <td className="px-4 py-2">
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className={inputClass}
          autoFocus
        />
      </td>
      <td className="px-4 py-2 space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase mr-1">Allowed kind</span>
          {KIND_OPTIONS.map((k) => {
            const on = form.allowedPartnerKind === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setForm((f) => ({ ...f, allowedPartnerKind: k }))}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400',
                )}
              >
                {k}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase whitespace-nowrap"
            title="Filter assignable parties to those who hold this partner-role globally (e.g. only employees can be a 'Project Lead'). The list only shows roles compatible with the kind you chose above."
          >
            Required partner-role
          </span>
          <select
            value={form.requiredPartnerRoleCode}
            onChange={(e) => setForm((f) => ({ ...f, requiredPartnerRoleCode: e.target.value }))}
            className={cn(inputClass, 'font-mono text-[11px] py-1 max-w-[220px]')}
          >
            <option value="">— None —</option>
            {eligibleRoles.map((rt) => (
              <option key={rt.id} value={rt.code}>{rt.code} ({rt.name})</option>
            ))}
          </select>
        </div>

        {/* M4a.3 — Required Job Titles (Professions). Multi-select. The
            picker filters assignable parties to those who hold AT LEAST ONE
            of the chosen job titles. Person-only constraint conceptually,
            but we render for orgs too in case an org has a registered
            'profession' (rare but allowed). */}
        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase"
              title="Filter assignable parties to those whose Job Title is in this list. Job titles are managed at /templates/types → Job Titles. Combined with Required partner-role above as AND — the party must satisfy both."
            >
              Required job title(s)
            </span>
            {professions.length === 0 && (
              <a
                href="/templates/types"
                className="text-[10px] text-blue-600 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                + Add job titles
              </a>
            )}
          </div>
          {professions.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {professions.map((p) => {
                const on = form.requiredProfessionIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggleProfession(p.id)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      on
                        ? 'border-violet-500 bg-violet-50 text-violet-700'
                        : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
                    )}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] italic text-slate-400 dark:text-slate-500">No job titles defined yet.</p>
          )}
        </div>
        <label
          className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300 pt-1"
          title="When checked, this role is REQUIRED at project creation — the project create form will render a required picker for it, and the server rejects projects without a primary assignment. Use for roles every project must have (Customer, Project Lead, …). Leave unchecked for optional roles (Architect, Engineer, etc.)."
        >
          <input
            type="checkbox"
            checked={form.isPrimaryRequired}
            onChange={(e) => setForm((f) => ({ ...f, isPrimaryRequired: e.target.checked }))}
          />
          Required on every project — exactly one party must hold this role as primary
        </label>
        <input
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="Description (optional)"
          className={cn(inputClass, 'text-[12px] py-1')}
        />
      </td>
      <td />
      <td className="px-4 py-2 text-right whitespace-nowrap">
        <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100" title="Cancel">
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.name.trim() || (isNew && !form.code.trim())}
          className="p-1.5 rounded hover:bg-blue-100 text-blue-600 hover:text-blue-700 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Save"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
