import { useState } from 'react';
import { Plus, Trash2, Pencil, Save, X, Tags, Lock } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import client from '@/api/client';

const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

interface RoleType {
  id: number;
  code: string;
  name: string;
  description: string | null;
  /** Coarse grouping (e.g. "cst" for customer, "sup" for supplier). Optional. */
  category: string | null;
  sortOrder: number;
  isSystem: boolean;
}

interface RelationshipType extends RoleType {
  // M3a — named-side fields (preferred). Each row reads as a sentence:
  // "{sideALabel} ({sideAKind}) ↔ {sideBLabel} ({sideBKind})".
  sideALabel: string | null;
  sideBLabel: string | null;
  sideAKind: string | null;        // 'person' | 'organization' | 'any'
  sideBKind: string | null;        // 'person' | 'organization' | 'project' | 'any'
  inverseLabel: string | null;
  isSymmetric: boolean;
  allowsMultiple: boolean;
  // Legacy fields — still used by the relationship service for validation
  // until M3b moves rows into the new tables.
  applicableTargetTypes: string | null;
  applicableSourceType: string | null;
  requiredSourceRoleCode: string | null;
  requiredTargetRoleCode: string | null;
}

const TARGET_OPTIONS = ['project', 'organization', 'department', 'team'] as const;
const SOURCE_OPTIONS = ['person', 'organization'] as const;
const SIDE_KIND_OPTIONS = ['person', 'organization', 'project', 'any'] as const;

export function PartnerTypesPage() {
  const [tab, setTab] = useState<'role-types' | 'relationship-types'>('role-types');
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('admin/partner-types', 'write');
  const canDelete = isAdmin || can('admin/partner-types', 'delete');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner Types"
        description="Configure the role and relationship types used by Business Partners. System types can be renamed but not deleted."
      />

      <div className="flex gap-1 border-b border-border">
        {([
          { key: 'role-types', label: 'Role Types' },
          { key: 'relationship-types', label: 'Relationship Types' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'role-types'
        ? <RoleTypesTab canWrite={canWrite} canDelete={canDelete} />
        : <RelationshipTypesTab canWrite={canWrite} canDelete={canDelete} />}
    </div>
  );
}

// ─── Role Types ──────────────────────────────────────────────────────────────

function RoleTypesTab({ canWrite, canDelete }: { canWrite: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);

  const { data: types = [], isLoading } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const remove = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/partner-types/role-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner-role-types'] });
      notify.success('Role type deleted', { code: 'PARTNER-TYPE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete role type'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-slate-500">Roles a partner can hold (employee, customer, etc.). Used in the partner profile and as filters.</p>
        {canWrite && editingId === null && (
          <button onClick={() => setEditingId('new')} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Role Type
          </button>
        )}
      </div>

      {isLoading ? (
        <TableSkeleton rows={4} cols={3} />
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2 text-left font-semibold w-32">Code</th>
                <th className="px-4 py-2 text-left font-semibold w-48">Name</th>
                <th className="px-4 py-2 text-left font-semibold w-24">Category</th>
                <th className="px-4 py-2 text-left font-semibold">Description</th>
                <th className="px-4 py-2 text-center font-semibold w-20">Origin</th>
                <th className="px-4 py-2 text-right font-semibold w-32"></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && (
                <RoleTypeEditRow onClose={() => setEditingId(null)} />
              )}
              {types.map((t) => (
                editingId === t.id
                  ? <RoleTypeEditRow key={t.id} type={t} onClose={() => setEditingId(null)} />
                  : (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono text-[12px] text-slate-600">{t.code}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{t.name}</td>
                      <td className="px-4 py-2.5">
                        {t.category ? (
                          <span className="inline-flex rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-700">
                            {t.category}
                          </span>
                        ) : <span className="italic text-slate-400 text-[11px]">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 text-[12px]">{t.description || <span className="italic text-slate-400">—</span>}</td>
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
                          <button onClick={() => setEditingId(t.id)} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700" title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && !t.isSystem && (
                          <button
                            onClick={() => { if (confirm(`Delete role type "${t.name}"?`)) remove.mutate(t.id); }}
                            className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RoleTypeEditRow({ type, onClose }: { type?: RoleType; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = !type;
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    category: type?.category ?? '',
  });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        // Always send category (empty string clears it server-side).
        category: form.category.trim().toLowerCase(),
      };
      if (isNew) body.code = form.code.trim().toLowerCase();
      else if (!type?.isSystem) body.code = form.code.trim().toLowerCase();
      return isNew
        ? client.post('/admin/partner-types/role-types', body).then((r) => r.data)
        : client.patch(`/admin/partner-types/role-types/${type!.id}`, body).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner-role-types'] });
      notify.success(isNew ? 'Role type created' : 'Role type updated', { code: 'PARTNER-TYPE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save'),
  });

  return (
    <tr className="border-t border-slate-100 bg-blue-50/30">
      <td className="px-4 py-2">
        <input
          value={form.code}
          onChange={(e) => setForm(f => ({ ...f, code: e.target.value }))}
          disabled={!isNew && type?.isSystem}
          placeholder="e.g. partner"
          className={cn(inputClass, 'font-mono text-[12px] disabled:bg-slate-100 disabled:cursor-not-allowed')}
        />
      </td>
      <td className="px-4 py-2">
        <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className={inputClass} autoFocus />
      </td>
      <td className="px-4 py-2">
        {/* Category — short code that groups related role types.
            Datalist offers the established codes so spelling stays consistent. */}
        <input
          list="partner-role-category-suggestions"
          value={form.category}
          onChange={(e) => setForm(f => ({ ...f, category: e.target.value }))}
          placeholder="e.g. cst"
          className={cn(inputClass, 'font-mono text-[12px]')}
        />
        <datalist id="partner-role-category-suggestions">
          <option value="cst" />
          <option value="sup" />
          <option value="mun" />
          <option value="int" />
          <option value="ext" />
        </datalist>
      </td>
      <td className="px-4 py-2" colSpan={2}>
        <input value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className={inputClass} />
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700" title="Cancel">
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || (!form.name.trim()) || (isNew && !form.code.trim())}
          className="p-1.5 rounded hover:bg-blue-100 text-blue-600 hover:text-blue-700 disabled:opacity-30 disabled:cursor-not-allowed"
          title="Save"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ─── Relationship Types ──────────────────────────────────────────────────────

function RelationshipTypesTab({ canWrite, canDelete }: { canWrite: boolean; canDelete: boolean }) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);

  const { data: types = [], isLoading } = useQuery<RelationshipType[]>({
    queryKey: ['partner-relationship-types'],
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });

  const remove = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/partner-types/relationship-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner-relationship-types'] });
      notify.success('Relationship type deleted', { code: 'PARTNER-RT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex-1 max-w-3xl">
          <p className="text-[12px] text-slate-500 mb-1">Relationship verbs between a partner and a target (project, organization, etc.).</p>
        </div>
        {canWrite && editingId === null && (
          <button onClick={() => setEditingId('new')} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Relationship Type
          </button>
        )}
      </div>

      {/* Explainer — each row names the two sides of a relationship so
          forms and lists read as sentences instead of generic "source/target". */}
      <div className="rounded-lg border border-slate-200 bg-blue-50/40 p-3 text-[12px] text-slate-700 space-y-2">
        <p className="font-semibold text-slate-800">What does each row do?</p>
        <p>
          A relationship type defines <strong>how two parties connect</strong> by naming each side.
          The names appear as labels on the create form, and as a readable sentence in every list.
        </p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li><strong>Side A label / kind</strong> — what the first party IS (e.g. <em>Employee</em>, a <code>person</code>).</li>
          <li><strong>Side B label / kind</strong> — what the second party IS (e.g. <em>Employer</em>, an <code>organization</code>).</li>
          <li><strong>Inverse label</strong> — how the rel reads when viewed from side B (e.g. <em>Employs</em>).</li>
          <li><strong>Allows multiple</strong> — uncheck for "one at a time" types like primary employer.</li>
        </ul>
        <p className="text-slate-600">
          <strong>Example</strong> — to express <em>"an external_contact is a contact-of a customer org"</em>:
          side A <code>Contact / person</code>, side B <code>Customer Org / organization</code>, inverse <code>Has contact</code>.
          (Plus the legacy required-role constraints below for validation.)
        </p>
      </div>

      {isLoading ? (
        <TableSkeleton rows={4} cols={4} />
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2 text-left font-semibold w-36">Code</th>
                <th className="px-4 py-2 text-left font-semibold w-48">Name</th>
                <th className="px-4 py-2 text-left font-semibold">Reads as</th>
                <th className="px-4 py-2 text-center font-semibold w-20">Type</th>
                <th className="px-4 py-2 text-right font-semibold w-32"></th>
              </tr>
            </thead>
            <tbody>
              {editingId === 'new' && (
                <RelationshipTypeEditRow onClose={() => setEditingId(null)} />
              )}
              {types.map((t) => (
                editingId === t.id
                  ? <RelationshipTypeEditRow key={t.id} type={t} onClose={() => setEditingId(null)} />
                  : (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono text-[12px] text-slate-600">{t.code}</td>
                      <td className="px-4 py-2.5 font-medium text-slate-800">{t.name}</td>
                      <td className="px-4 py-2.5">
                        {/* Reads as: "{Side A} ({kind}) ↔ {Side B} ({kind})" — the
                            new clear-sentence format. If sides aren't filled
                            in yet, show the legacy summary as a fallback. */}
                        {t.sideALabel || t.sideBLabel ? (
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                              <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">
                                {t.sideALabel || '?'}
                              </span>
                              {t.sideAKind && (
                                <span className="text-[10px] text-slate-400">({t.sideAKind})</span>
                              )}
                              <span className="text-slate-400 mx-0.5">{t.isSymmetric ? '⇄' : '→'}</span>
                              <span className="rounded-full bg-violet-50 px-2 py-0.5 font-semibold text-violet-700">
                                {t.sideBLabel || '?'}
                              </span>
                              {t.sideBKind && (
                                <span className="text-[10px] text-slate-400">({t.sideBKind})</span>
                              )}
                            </div>
                            {(t.inverseLabel || !t.allowsMultiple) && (
                              <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                                {t.inverseLabel && <span>inverse: <span className="font-medium text-slate-600">{t.inverseLabel}</span></span>}
                                {!t.allowsMultiple && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700">one at a time</span>}
                              </div>
                            )}
                            {(t.requiredSourceRoleCode || t.requiredTargetRoleCode) && (
                              <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                                <span>requires:</span>
                                {t.requiredSourceRoleCode && (
                                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700">A: {t.requiredSourceRoleCode}</span>
                                )}
                                {t.requiredTargetRoleCode && (
                                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700">B: {t.requiredTargetRoleCode}</span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="italic text-slate-400 text-[12px]">Sides not configured</span>
                        )}
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
                          <button onClick={() => setEditingId(t.id)} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700" title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canDelete && !t.isSystem && (
                          <button
                            onClick={() => { if (confirm(`Delete relationship type "${t.name}"?`)) remove.mutate(t.id); }}
                            className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RelationshipTypeEditRow({ type, onClose }: { type?: RelationshipType; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = !type;

  // Pull the role-type catalog so the source/target role dropdowns show real
  // codes instead of asking the admin to remember-and-spell. Cached for 10
  // minutes since these don't change often.
  const { data: roleTypes = [] } = useQuery<RoleType[]>({
    queryKey: ['partner-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/role-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    sideALabel: type?.sideALabel ?? '',
    sideBLabel: type?.sideBLabel ?? '',
    sideAKind: type?.sideAKind ?? '',
    sideBKind: type?.sideBKind ?? '',
    inverseLabel: type?.inverseLabel ?? '',
    isSymmetric: type?.isSymmetric ?? false,
    allowsMultiple: type?.allowsMultiple ?? true,
    applicableTargetTypes: (type?.applicableTargetTypes ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    applicableSourceType: (type?.applicableSourceType ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    requiredSourceRoleCode: type?.requiredSourceRoleCode ?? '',
    requiredTargetRoleCode: type?.requiredTargetRoleCode ?? '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggleTarget = (t: string) => {
    setForm((f) => ({
      ...f,
      applicableTargetTypes: f.applicableTargetTypes.includes(t)
        ? f.applicableTargetTypes.filter((x) => x !== t)
        : [...f.applicableTargetTypes, t],
    }));
  };
  const toggleSource = (s: string) => {
    setForm((f) => ({
      ...f,
      applicableSourceType: f.applicableSourceType.includes(s)
        ? f.applicableSourceType.filter((x) => x !== s)
        : [...f.applicableSourceType, s],
    }));
  };

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        sideALabel: form.sideALabel.trim() || undefined,
        sideBLabel: form.sideBLabel.trim() || undefined,
        sideAKind: form.sideAKind || undefined,
        sideBKind: form.sideBKind || undefined,
        inverseLabel: form.inverseLabel.trim() || undefined,
        isSymmetric: form.isSymmetric,
        allowsMultiple: form.allowsMultiple,
        applicableTargetTypes: form.applicableTargetTypes.length > 0 ? form.applicableTargetTypes.join(',') : undefined,
        applicableSourceType: form.applicableSourceType.length > 0 ? form.applicableSourceType.join(',') : undefined,
        requiredSourceRoleCode: form.requiredSourceRoleCode.trim() || undefined,
        requiredTargetRoleCode: form.requiredTargetRoleCode.trim() || undefined,
      };
      if (isNew) body.code = form.code.trim().toLowerCase();
      else if (!type?.isSystem) body.code = form.code.trim().toLowerCase();
      return isNew
        ? client.post('/admin/partner-types/relationship-types', body).then((r) => r.data)
        : client.patch(`/admin/partner-types/relationship-types/${type!.id}`, body).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner-relationship-types'] });
      notify.success(isNew ? 'Relationship type created' : 'Relationship type updated', { code: 'PARTNER-RT-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save'),
  });

  return (
    <tr className="border-t border-slate-100 bg-blue-50/30">
      <td className="px-4 py-2">
        <input
          value={form.code}
          onChange={(e) => setForm(f => ({ ...f, code: e.target.value }))}
          disabled={!isNew && type?.isSystem}
          placeholder="e.g. mentor_of"
          className={cn(inputClass, 'font-mono text-[12px] disabled:bg-slate-100 disabled:cursor-not-allowed')}
        />
      </td>
      <td className="px-4 py-2">
        <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className={inputClass} autoFocus />
      </td>
      <td className="px-4 py-2 space-y-2">
        {/* Side A / Side B — the named-sides model. The form labels for the
            create-relationship dialog use these strings, so picking good
            labels here is what makes the partner-drawer form readable. */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-blue-700 uppercase block">Side A</label>
            <input
              value={form.sideALabel}
              onChange={(e) => setForm(f => ({ ...f, sideALabel: e.target.value }))}
              placeholder="e.g. Employee"
              className={cn(inputClass, 'text-[12px] py-1')}
            />
            <select
              value={form.sideAKind}
              onChange={(e) => setForm(f => ({ ...f, sideAKind: e.target.value }))}
              className={cn(inputClass, 'text-[11px] py-1 font-mono')}
            >
              <option value="">— kind —</option>
              {SIDE_KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-violet-700 uppercase block">
              Side B {form.isSymmetric ? '(same as A)' : ''}
            </label>
            <input
              value={form.sideBLabel}
              onChange={(e) => setForm(f => ({ ...f, sideBLabel: e.target.value }))}
              placeholder="e.g. Employer"
              className={cn(inputClass, 'text-[12px] py-1')}
            />
            <select
              value={form.sideBKind}
              onChange={(e) => setForm(f => ({ ...f, sideBKind: e.target.value }))}
              className={cn(inputClass, 'text-[11px] py-1 font-mono')}
            >
              <option value="">— kind —</option>
              {SIDE_KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap text-[11px]">
          <div className="flex-1 min-w-[160px]">
            <span className="text-[10px] font-semibold text-slate-400 uppercase block mb-0.5">Inverse label</span>
            <input
              value={form.inverseLabel}
              onChange={(e) => setForm(f => ({ ...f, inverseLabel: e.target.value }))}
              placeholder="e.g. Employs"
              className={cn(inputClass, 'text-[12px] py-1')}
            />
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isSymmetric}
              onChange={(e) => setForm(f => ({ ...f, isSymmetric: e.target.checked }))}
            />
            <span className="text-slate-600">Symmetric</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={form.allowsMultiple}
              onChange={(e) => setForm(f => ({ ...f, allowsMultiple: e.target.checked }))}
            />
            <span className="text-slate-600">Allows multiple</span>
          </label>
        </div>

        {/* Advanced — legacy validation rules. Kept until M3b moves the
            data to PartnerRelationship + ProjectPartnerRole, where the
            constraints will live in cleaner per-table form. */}
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="text-[10px] text-slate-400 hover:text-slate-600 underline"
        >
          {showAdvanced ? '− Hide' : '+ Show'} validation rules (legacy)
        </button>
        {showAdvanced && (
          <div className="space-y-1.5 rounded-lg bg-slate-50 p-2">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] font-semibold text-slate-400 uppercase mr-1">Source kinds</span>
              {SOURCE_OPTIONS.map((s) => {
                const on = form.applicableSourceType.includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleSource(s)}
                    className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500')}>
                    {s}
                  </button>
                );
              })}
              <span className="text-[10px] text-slate-400 mx-1">→</span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase mr-1">Target kinds</span>
              {TARGET_OPTIONS.map((t) => {
                const on = form.applicableTargetTypes.includes(t);
                return (
                  <button key={t} type="button" onClick={() => toggleTarget(t)}
                    className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      on ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-500')}>
                    {t}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-semibold text-slate-400 uppercase whitespace-nowrap">Required source role</span>
              <select
                value={form.requiredSourceRoleCode}
                onChange={(e) => setForm(f => ({ ...f, requiredSourceRoleCode: e.target.value }))}
                className={cn(inputClass, 'font-mono text-[11px] py-1 max-w-[200px]')}
              >
                <option value="">— Any —</option>
                {roleTypes.map((rt) => (
                  <option key={rt.id} value={rt.code}>{rt.code} ({rt.name})</option>
                ))}
              </select>
              <span className="text-[10px] font-semibold text-slate-400 uppercase whitespace-nowrap">Required target role</span>
              <select
                value={form.requiredTargetRoleCode}
                onChange={(e) => setForm(f => ({ ...f, requiredTargetRoleCode: e.target.value }))}
                className={cn(inputClass, 'font-mono text-[11px] py-1 max-w-[200px]')}
              >
                <option value="">— Any —</option>
                {roleTypes.map((rt) => (
                  <option key={rt.id} value={rt.code}>{rt.code} ({rt.name})</option>
                ))}
              </select>
            </div>
          </div>
        )}
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
