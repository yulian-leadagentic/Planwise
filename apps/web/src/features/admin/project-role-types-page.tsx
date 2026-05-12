import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Trash2, Pencil, Save, X, Briefcase, Lock } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import client from '@/api/client';

// Project Role Types — catalog of roles a party can hold on a project
// (Customer, Supplier, Participant, Architect, …). Mirrors the existing
// Partner Role Types screen but for project-side assignments. The 6
// seeded rows are protected from delete; admins can add custom roles.

interface ProjectRoleType {
  id: number;
  code: string;
  name: string;
  description: string | null;
  allowedPartnerKind: 'person' | 'organization' | 'any';
  requiredPartnerRoleCode: string | null;
  isPrimaryRequired: boolean;
  sortOrder: number;
  isSystem: boolean;
}

interface PartnerRoleType {
  id: number;
  code: string;
  name: string;
}

const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';
const KIND_OPTIONS: Array<'person' | 'organization' | 'any'> = ['any', 'person', 'organization'];

export function ProjectRoleTypesPage() {
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('admin/project-role-types', 'write');
  const canDelete = isAdmin || can('admin/project-role-types', 'delete');
  const queryClient = useQueryClient();
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
      <div className="rounded-lg border border-slate-200 bg-blue-50/40 p-3 text-[12px] text-slate-700 space-y-2">
        <p className="font-semibold text-slate-800">What does each row do?</p>
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
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
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
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono text-[12px] text-slate-600">{t.code}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{t.name}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{t.allowedPartnerKind}</span>
                          {t.requiredPartnerRoleCode && (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                              requires: {t.requiredPartnerRoleCode}
                            </span>
                          )}
                          {t.isPrimaryRequired && (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                              one primary
                            </span>
                          )}
                        </div>
                        {t.description && <p className="text-[11px] text-slate-500 mt-0.5">{t.description}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {t.isSystem ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                            <Lock className="h-2.5 w-2.5" /> System
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">Custom</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canWrite && (
                          <button
                            onClick={() => setEditingId(t.id)}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && !t.isSystem && (
                          <button
                            onClick={() => {
                              if (confirm(`Delete project role "${t.name}"?`)) remove.mutate(t.id);
                            }}
                            className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
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
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400 text-sm">
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

  // Live partner role catalog — used for the requiredPartnerRoleCode dropdown.
  const { data: partnerRoleTypes = [] } = useQuery<PartnerRoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    allowedPartnerKind: (type?.allowedPartnerKind ?? 'any') as 'person' | 'organization' | 'any',
    requiredPartnerRoleCode: type?.requiredPartnerRoleCode ?? '',
    isPrimaryRequired: type?.isPrimaryRequired ?? false,
    sortOrder: type?.sortOrder ?? 0,
  });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        allowedPartnerKind: form.allowedPartnerKind,
        requiredPartnerRoleCode: form.requiredPartnerRoleCode || null,
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
    <tr className="border-t border-slate-100 bg-blue-50/30">
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
          <span className="text-[10px] font-semibold text-slate-400 uppercase mr-1">Allowed kind</span>
          {KIND_OPTIONS.map((k) => {
            const on = form.allowedPartnerKind === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setForm((f) => ({ ...f, allowedPartnerKind: k }))}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500',
                )}
              >
                {k}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-slate-400 uppercase whitespace-nowrap">Required partner-role</span>
          <select
            value={form.requiredPartnerRoleCode}
            onChange={(e) => setForm((f) => ({ ...f, requiredPartnerRoleCode: e.target.value }))}
            className={cn(inputClass, 'font-mono text-[11px] py-1 max-w-[220px]')}
          >
            <option value="">— None —</option>
            {partnerRoleTypes.map((rt) => (
              <option key={rt.id} value={rt.code}>{rt.code} ({rt.name})</option>
            ))}
          </select>
        </div>
        <label
          className="flex items-center gap-2 text-[11px] text-slate-600 pt-1"
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
        <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700" title="Cancel">
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
