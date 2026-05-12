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
  /** Which party kind can hold this role: 'person', 'organization', or 'any'. */
  appliesToKind: 'person' | 'organization' | 'any';
  sortOrder: number;
  isSystem: boolean;
}

/**
 * M3.5 — Structured side target. A side accepts a party if it matches AT
 * LEAST ONE entry: the party's partnerType matches `kind`, AND
 * (no role constraints, OR the party holds a role whose code is in
 * roleCodes, OR the party holds a role whose category is in categoryCodes).
 */
interface SideTarget {
  kind: 'person' | 'organization' | 'project' | 'any';
  roleCodes?: string[];
  categoryCodes?: string[];
}

interface RelationshipType extends RoleType {
  // M3.5 — structured target lists (preferred).
  sideATargets: SideTarget[] | null;
  sideBTargets: SideTarget[] | null;
  // Optional human labels (free text). When null, we auto-derive from
  // sideATargets/sideBTargets in the UI.
  sideALabel: string | null;
  sideBLabel: string | null;
  inverseLabel: string | null;
  isSymmetric: boolean;
  allowsMultiple: boolean;
  // Legacy (auto-shimmed server-side from the JSON targets). Kept on the
  // type so the existing rel validator keeps working until M7.
  sideAKind: string | null;
  sideBKind: string | null;
  applicableTargetTypes: string | null;
  applicableSourceType: string | null;
  requiredSourceRoleCode: string | null;
  requiredTargetRoleCode: string | null;
}

// Only party kinds. Project-side roles belong in /admin/project-role-types,
// not here — relationships are party↔party. Existing system rows with
// side_b_kind='project' still render but can't be re-saved with that kind.
const SIDE_KIND_OPTIONS = ['person', 'organization'] as const;
type SideKind = (typeof SIDE_KIND_OPTIONS)[number];

/** Render one side's target list as a compact sentence, e.g.
 *  "Organization with role: customer, supplier  |  Project". */
function summarizeSide(targets: SideTarget[] | null, fallbackLabel: string | null): string {
  if (!targets?.length) return fallbackLabel || 'Any';
  return targets
    .map((t) => {
      let s = t.kind === 'any' ? 'Any' : t.kind.charAt(0).toUpperCase() + t.kind.slice(1);
      const constraints: string[] = [];
      if (t.roleCodes?.length) constraints.push(`role: ${t.roleCodes.join(', ')}`);
      if (t.categoryCodes?.length) constraints.push(`category: ${t.categoryCodes.join(', ')}`);
      if (constraints.length) s += ` (${constraints.join(' / ')})`;
      return s;
    })
    .join('  |  ');
}

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
          <button
            onClick={() => setEditingId('new')}
            title="Define a new kind of role a partner can hold (e.g. customer, supplier, contractor). Roles are global tags on the partner — they show up in the partner drawer and drive who's eligible for relationship-type and project-role pickers."
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
          >
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
                <th className="px-4 py-2 text-left font-semibold w-28">Applies to</th>
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
                      <td className="px-4 py-2.5">
                        <span className={cn(
                          'inline-flex rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold',
                          t.appliesToKind === 'person' && 'bg-blue-50 text-blue-700',
                          t.appliesToKind === 'organization' && 'bg-emerald-50 text-emerald-700',
                          t.appliesToKind === 'any' && 'bg-slate-100 text-slate-600',
                        )}>
                          {t.appliesToKind}
                        </span>
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

// Derive a stable lowercase_with_underscores code from a free-text name.
// Used by both Role Type and Relationship Type forms.
function deriveCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function RoleTypeEditRow({ type, onClose }: { type?: RoleType; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isNew = !type;
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    category: type?.category ?? '',
    appliesToKind: (type?.appliesToKind ?? 'any') as 'person' | 'organization' | 'any',
  });
  // Once the user touches the Code field, stop syncing it to Name.
  const [codeTouched, setCodeTouched] = useState(!isNew);

  // Datalist source for the Category picker — DISTINCT values already used
  // across the role-type catalog. Stops users typing 'cst', 'CST', 'cust'
  // variants of the same thing.
  const { data: categorySuggestions = [] } = useQuery<string[]>({
    queryKey: ['partner-role-categories'],
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/role-types/categories').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        // Always send category (empty string clears it server-side).
        category: form.category.trim().toLowerCase(),
        appliesToKind: form.appliesToKind,
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
          onChange={(e) => {
            setCodeTouched(true);
            setForm((f) => ({ ...f, code: e.target.value }));
          }}
          disabled={!isNew && type?.isSystem}
          placeholder="auto-fills from name"
          className={cn(inputClass, 'font-mono text-[12px] disabled:bg-slate-100 disabled:cursor-not-allowed')}
        />
      </td>
      <td className="px-4 py-2">
        <input
          value={form.name}
          onChange={(e) => {
            const v = e.target.value;
            setForm((f) => ({
              ...f,
              name: v,
              // Auto-derive the code while the user hasn't touched the Code field.
              code: codeTouched ? f.code : deriveCode(v),
            }));
          }}
          className={inputClass}
          autoFocus
        />
      </td>
      <td className="px-4 py-2">
        {/* Category — datalist sourced from existing DISTINCT values in
            partner_role_types so admins don't spawn 'cst', 'CST', 'cust'
            variants of the same thing. */}
        <input
          list="partner-role-category-suggestions"
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
          placeholder="(optional)"
          className={cn(inputClass, 'font-mono text-[12px]')}
        />
        <datalist id="partner-role-category-suggestions">
          {categorySuggestions.map((c) => <option key={c} value={c} />)}
        </datalist>
      </td>
      <td className="px-4 py-2">
        {/* Applies to — drives which roles appear when a side picker has
            kind=person vs kind=organization. 'any' shows the role under
            both kinds; the specific options hide it from the wrong one. */}
        <select
          value={form.appliesToKind}
          onChange={(e) => setForm((f) => ({ ...f, appliesToKind: e.target.value as 'person' | 'organization' | 'any' }))}
          className={cn(inputClass, 'text-[12px] py-1')}
        >
          <option value="any">any</option>
          <option value="person">person</option>
          <option value="organization">organization</option>
        </select>
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
          <p className="text-[12px] text-slate-500 mb-1">
            Defines how two business partners can be connected (person↔organization, organization↔organization, etc.). For a party's role on a specific project, use <a href="/admin/project-role-types" className="text-blue-600 hover:underline">Project Role Types</a> instead.
          </p>
        </div>
        {canWrite && editingId === null && (
          <button
            onClick={() => setEditingId('new')}
            title="Define a new partner-to-partner relationship kind (e.g. 'contact_at_customer', 'subsidiary_of'). Each type names both sides and constrains which kinds and roles can hold each side. Project-side roles belong in Project Role Types, not here."
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1"
          >
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
                        {/* Reads as: "Side A summary  →  Side B summary".
                            Side summary built from the structured target list. */}
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                            <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                              {summarizeSide(t.sideATargets, t.sideALabel)}
                            </span>
                            <span className="text-slate-400 mx-0.5">{t.isSymmetric ? '⇄' : '→'}</span>
                            <span className="rounded-md bg-violet-50 px-2 py-0.5 font-medium text-violet-700">
                              {summarizeSide(t.sideBTargets, t.sideBLabel)}
                            </span>
                          </div>
                          {(t.inverseLabel || !t.allowsMultiple) && (
                            <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                              {t.inverseLabel && <span>inverse: <span className="font-medium text-slate-600">{t.inverseLabel}</span></span>}
                              {!t.allowsMultiple && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700">one at a time</span>}
                            </div>
                          )}
                        </div>
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
    sideATargets: (type?.sideATargets ?? []) as SideTarget[],
    sideBTargets: (type?.sideBTargets ?? []) as SideTarget[],
    sideALabel: type?.sideALabel ?? '',
    sideBLabel: type?.sideBLabel ?? '',
    inverseLabel: type?.inverseLabel ?? '',
    isSymmetric: type?.isSymmetric ?? false,
    allowsMultiple: type?.allowsMultiple ?? true,
  });
  const [codeTouched, setCodeTouched] = useState(!isNew);

  const { data: categorySuggestions = [] } = useQuery<string[]>({
    queryKey: ['partner-role-categories'],
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get('/admin/partner-types/role-types/categories').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        sideATargets: form.sideATargets.length ? form.sideATargets : null,
        sideBTargets: form.sideBTargets.length ? form.sideBTargets : null,
        sideALabel: form.sideALabel.trim() || undefined,
        sideBLabel: form.sideBLabel.trim() || undefined,
        inverseLabel: form.inverseLabel.trim() || undefined,
        isSymmetric: form.isSymmetric,
        allowsMultiple: form.allowsMultiple,
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
          onChange={(e) => {
            setCodeTouched(true);
            setForm((f) => ({ ...f, code: e.target.value }));
          }}
          disabled={!isNew && type?.isSystem}
          placeholder="auto-fills from name"
          className={cn(inputClass, 'font-mono text-[12px] disabled:bg-slate-100 disabled:cursor-not-allowed')}
        />
      </td>
      <td className="px-4 py-2">
        <input
          value={form.name}
          onChange={(e) => {
            const v = e.target.value;
            setForm((f) => ({ ...f, name: v, code: codeTouched ? f.code : deriveCode(v) }));
          }}
          className={inputClass}
          autoFocus
        />
      </td>
      <td className="px-4 py-2 space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <SidePickerCard
            color="blue"
            label="Side A"
            optionalDisplayLabel={form.sideALabel}
            onDisplayLabelChange={(v) => setForm((f) => ({ ...f, sideALabel: v }))}
            value={form.sideATargets}
            onChange={(v) => setForm((f) => ({ ...f, sideATargets: v }))}
            roleTypes={roleTypes}
            categorySuggestions={categorySuggestions}
          />
          <SidePickerCard
            color="violet"
            label={form.isSymmetric ? 'Side B (same as A — ignored)' : 'Side B'}
            optionalDisplayLabel={form.sideBLabel}
            onDisplayLabelChange={(v) => setForm((f) => ({ ...f, sideBLabel: v }))}
            value={form.sideBTargets}
            onChange={(v) => setForm((f) => ({ ...f, sideBTargets: v }))}
            roleTypes={roleTypes}
            categorySuggestions={categorySuggestions}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap text-[11px]">
          <div
            className="flex-1 min-w-[180px]"
            title="How the relationship reads when viewed from Side B's drawer. Example: type 'worker_of' shows on the person's drawer as 'Employer ← Acme'; on Acme's drawer it should show as 'Employs ← John' — set the inverse label to 'Employs'. Leave empty if symmetric or if the type name reads the same both ways."
          >
            <span className="text-[10px] font-semibold text-slate-400 uppercase block mb-0.5">Inverse label (reads back from side B)</span>
            <input
              value={form.inverseLabel}
              onChange={(e) => setForm((f) => ({ ...f, inverseLabel: e.target.value }))}
              placeholder="e.g. Employs"
              className={cn(inputClass, 'text-[12px] py-1')}
            />
          </div>
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            title="Check if the relationship reads the same from either side (e.g. 'partner_of': if A partner_of B, then B partner_of A). Side B is ignored when symmetric — the system clones side A. Most rels are asymmetric (employee ≠ employer)."
          >
            <input
              type="checkbox"
              checked={form.isSymmetric}
              onChange={(e) => setForm((f) => ({ ...f, isSymmetric: e.target.checked }))}
            />
            <span className="text-slate-600">Symmetric</span>
          </label>
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            title="If checked, a partner can hold several active relationships of this type at once (e.g. a supplier can be a supplier on many projects). If unchecked, creating a new relationship soft-ends the existing one (e.g. exactly one primary employer at a time)."
          >
            <input
              type="checkbox"
              checked={form.allowsMultiple}
              onChange={(e) => setForm((f) => ({ ...f, allowsMultiple: e.target.checked }))}
            />
            <span className="text-slate-600">Allow multiple active instances</span>
          </label>
        </div>

        {/* Live preview — the same sentence the rest of the UI will render. */}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-700">
          <span className="text-[10px] font-semibold text-slate-400 uppercase mr-2">Reads as</span>
          <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
            {summarizeSide(form.sideATargets, form.sideALabel || null)}
          </span>
          <span className="text-slate-400 mx-1.5">{form.isSymmetric ? '⇄' : '→'}</span>
          <span className="rounded-md bg-violet-50 px-2 py-0.5 font-medium text-violet-700">
            {summarizeSide(form.sideBTargets, form.sideBLabel || null)}
          </span>
        </div>
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

// ─── SidePickerCard ──────────────────────────────────────────────────────────
//
// One side of a PartnerRelationshipType. Internally a list of "targets",
// each target being:
//   { kind, roleCodes[], categoryCodes[] }
//
// UI: a stack of target cards with [+ Add target] at the bottom. Each card
// picks an entity kind first (person / organization / project); for person
// / organization, two role/category checkbox grids appear. Multiple targets
// on one side express OR (e.g. "Project | Organization w/ role customer").

function SidePickerCard({
  color,
  label,
  optionalDisplayLabel,
  onDisplayLabelChange,
  value,
  onChange,
  roleTypes,
  categorySuggestions,
}: {
  color: 'blue' | 'violet';
  label: string;
  optionalDisplayLabel: string;
  onDisplayLabelChange: (v: string) => void;
  value: SideTarget[];
  onChange: (v: SideTarget[]) => void;
  roleTypes: RoleType[];
  categorySuggestions: string[];
}) {
  const headerCls = color === 'blue' ? 'text-blue-700' : 'text-violet-700';
  const cardBgCls = color === 'blue' ? 'bg-blue-50/50 border-blue-100' : 'bg-violet-50/50 border-violet-100';

  const updateAt = (i: number, patch: Partial<SideTarget>) => {
    onChange(value.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  };
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { kind: 'person' }]);

  return (
    <div className={cn('rounded-lg border p-2.5 space-y-2', cardBgCls)}>
      <div className="flex items-center justify-between">
        <span className={cn('text-[10px] font-semibold uppercase', headerCls)}>{label}</span>
        <span className="text-[10px] text-slate-400">{value.length === 0 ? 'No targets — accepts any party' : `${value.length} target${value.length > 1 ? 's' : ''}`}</span>
      </div>

      <div className="space-y-1.5">
        {value.map((target, idx) => (
          <TargetRow
            key={idx}
            target={target}
            onChange={(patch) => updateAt(idx, patch)}
            onRemove={() => removeAt(idx)}
            roleTypes={roleTypes}
            categorySuggestions={categorySuggestions}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        title="Add another allowed target kind to this side. Multiple targets read as OR — e.g. a Subcontractor's side B can accept a Project OR an Organization with role customer OR supplier."
        className="w-full rounded border border-dashed border-slate-300 text-[11px] text-slate-500 py-1 hover:bg-white hover:text-slate-700"
      >
        + Add target
      </button>

      <div>
        <label className="text-[9px] font-semibold text-slate-400 uppercase block">
          Display label (optional — defaults to summary above)
        </label>
        <input
          value={optionalDisplayLabel}
          onChange={(e) => onDisplayLabelChange(e.target.value)}
          placeholder="e.g. Employee"
          className={cn(inputClass, 'text-[11px] py-1')}
        />
      </div>
    </div>
  );
}

function TargetRow({
  target,
  onChange,
  onRemove,
  roleTypes,
  categorySuggestions,
}: {
  target: SideTarget;
  onChange: (patch: Partial<SideTarget>) => void;
  onRemove: () => void;
  roleTypes: RoleType[];
  categorySuggestions: string[];
}) {
  // Per-target toggle: by default we only show roles whose appliesToKind
  // is compatible with this target's kind. The "show all" escape hatch
  // surfaces every role for the rare advanced case (e.g. a custom role
  // that wasn't tagged yet).
  const [showAllRoles, setShowAllRoles] = useState(false);

  const toggle = (key: 'roleCodes' | 'categoryCodes', code: string) => {
    const current = target[key] ?? [];
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    onChange({ [key]: next.length ? next : undefined });
  };

  // Roles relevant to the chosen kind. 'any' targets show all roles; a
  // specific kind shows roles tagged for that kind OR 'any'.
  const visibleRoles = showAllRoles
    ? roleTypes
    : roleTypes.filter((r) => {
        if (target.kind === 'any') return true;
        return r.appliesToKind === 'any' || r.appliesToKind === target.kind;
      });
  const hiddenCount = roleTypes.length - visibleRoles.length;

  // Currently-selected roles that the filter hides (e.g. user previously
  // picked a person-only role, then changed the target's kind to org).
  // Always render those chips so users can deselect them; mark visually.
  const selectedHidden = (target.roleCodes ?? []).filter((c) => !visibleRoles.some((r) => r.code === c));
  const effectiveRoles = showAllRoles
    ? visibleRoles
    : [...visibleRoles, ...roleTypes.filter((r) => selectedHidden.includes(r.code))];

  const rolesByCategory = effectiveRoles.reduce<Record<string, RoleType[]>>((acc, r) => {
    const key = r.category || '_uncategorized';
    (acc[key] ||= []).push(r);
    return acc;
  }, {});
  const sortedCategoryKeys = Object.keys(rolesByCategory).sort();

  const showRoleFilters = target.kind === 'person' || target.kind === 'organization' || target.kind === 'any';

  // Legacy rows may still carry kind='project' (the system seeds
  // customer_of_project / supplier_of_project / participates_in_project).
  // We surface that as an option only when already selected, so admins can
  // see and clear it but not introduce new project-targeted rels.
  const showLegacyProject = target.kind === 'project';

  return (
    <div className="rounded border border-slate-200 bg-white p-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <select
          value={target.kind}
          onChange={(e) => onChange({ kind: e.target.value as SideKind | 'any' })}
          className={cn(inputClass, 'text-[12px] py-1 max-w-[160px] font-mono')}
          title="What kind of party can sit on this side"
        >
          {SIDE_KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
          <option value="any">any</option>
          {showLegacyProject && <option value="project">project (legacy)</option>}
        </select>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
          title="Remove this target from this side"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {showLegacyProject && (
        <p className="text-[10px] text-amber-700 bg-amber-50 px-2 py-1 rounded">
          'project' is legacy here. To define roles a party holds on a project, use{' '}
          <a href="/admin/project-role-types" className="font-semibold underline">Project Role Types</a> instead.
        </p>
      )}

      {showRoleFilters && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-slate-400 uppercase">Restrict to roles (optional)</span>
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllRoles((s) => !s)}
                  className="text-[10px] text-blue-600 hover:underline"
                >
                  {showAllRoles
                    ? `Showing all (${roleTypes.length})`
                    : `Show all (${hiddenCount} hidden — don't apply to ${target.kind})`}
                </button>
              )}
            </div>
            <div className="space-y-1">
              {sortedCategoryKeys.map((cat) => (
                <div key={cat} className="flex flex-wrap items-center gap-1">
                  <span className="text-[9px] text-slate-400 font-mono uppercase mr-1">
                    {cat === '_uncategorized' ? '(no category)' : cat}
                  </span>
                  {rolesByCategory[cat].map((r) => {
                    const on = (target.roleCodes ?? []).includes(r.code);
                    const mismatched =
                      target.kind !== 'any' &&
                      r.appliesToKind !== 'any' &&
                      r.appliesToKind !== target.kind;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggle('roleCodes', r.code)}
                        title={mismatched ? `'${r.code}' applies to ${r.appliesToKind}, not ${target.kind} — will never match` : r.name}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          on
                            ? mismatched
                              ? 'border-red-400 bg-red-50 text-red-700 line-through'
                              : 'border-amber-400 bg-amber-50 text-amber-800'
                            : mismatched
                              ? 'border-red-200 text-red-400 hover:border-red-300'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300',
                        )}
                      >
                        {r.code}
                      </button>
                    );
                  })}
                </div>
              ))}
              {roleTypes.length === 0 && (
                <span className="text-[10px] italic text-slate-400">No role types defined yet.</span>
              )}
            </div>
          </div>

          {categorySuggestions.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-400 uppercase block">…or by category (matches any role in the group)</span>
              <div className="flex flex-wrap gap-1">
                {categorySuggestions.map((c) => {
                  const on = (target.categoryCodes ?? []).includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggle('categoryCodes', c)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-mono font-medium',
                        on
                          ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300',
                      )}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {target.kind === 'project' && (
        <p className="text-[10px] italic text-slate-400">Projects don't have partner-roles — no further filtering.</p>
      )}
    </div>
  );
}
