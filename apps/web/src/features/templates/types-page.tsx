import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus, Search, Trash2, X, LayoutGrid } from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ColorPalettePicker } from '@/components/shared/color-palette-picker';
import { Tabs, tabPanelId, tabTriggerId, useUrlTab } from '@/components/shared/tabs';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

// ---------------------------------------------------------------------------
// Zone types are now persisted via /admin/config/zone-types (ZoneTypeMeta).
// The 8 enum values (site/building/level/floor/wing/section/area/zone) are
// seeded by migration; admins can edit (label/colour/icon/sort) and delete
// metadata rows. Deletion only removes the meta — the enum value still
// exists, so any zones that already reference it keep working.
//
// Adding entirely new zone types isn't supported here because new enum
// values require a Prisma migration (the schema-level constraint).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
// QA3 Wave-1 Commit 3A (2026-09-22): the `'service'` tab was mislabelled
// "Project Categories" but wired to /service-types (ServiceType) — while
// the New-Project dropdown reads /admin/config/project-types (ProjectType).
// Result: adding a "category" in Templates→Types didn't appear in
// New-Project. Fix: rename the ServiceType tab to "Services" (which is
// what it actually manages) and add a new "Project Categories" tab wired
// to the ProjectType table that New-Project actually reads.
type TabKey = 'zone' | 'projectCategory' | 'service' | 'department' | 'profession' | 'position';

const TAB_VALUES = ['zone', 'projectCategory', 'service', 'department', 'profession', 'position'] as const satisfies readonly TabKey[];

// QA4 JT-3 (2026-09-29) — the old "Job Titles" tab renamed to
// "Qualifications" (matches the partner-drawer rename and the JT-1 split
// semantics: `professions` is the eligibility-gate axis). A new
// "Positions" tab manages the descriptive-title catalog (`positions`
// table) that feeds the drawer + People page Position pickers.
const TABS: { value: TabKey; label: string }[] = [
  { value: 'zone', label: 'Zone Types' },
  { value: 'projectCategory', label: 'Project Categories' },
  { value: 'service', label: 'Services' },
  { value: 'department', label: 'Departments' },
  { value: 'position', label: 'Positions' },
  { value: 'profession', label: 'Qualifications' },
];

// ---------------------------------------------------------------------------
// Inline color input component
// ---------------------------------------------------------------------------
/**
 * Inline colour picker used in the editing row of every Types & Categories
 * tab (Zone Types, Project Categories, Departments, Professions). Wraps the
 * shared <ColorPalettePicker> so the same curated palette is offered
 * everywhere — no more raw-hex-only fields.
 */
function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <ColorPalettePicker value={value || '#6B7280'} onChange={onChange} />
  );
}

// ---------------------------------------------------------------------------
// Edit state type
// ---------------------------------------------------------------------------
interface EditState {
  id: string | number;
  name: string;
  code: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function TypesPage() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // People UX M5 (E-27) — `?tab=` URL sync via the shared useUrlTab hook.
  // Deep-linked shares reopen the right sub-view; role=tab / aria-selected /
  // arrow-key navigation come from the shared Tabs component below.
  const [activeTab, setActiveTabRaw] = useUrlTab<TabKey>('tab', TAB_VALUES, 'zone');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formColor, setFormColor] = useState('');

  // Inline edit state
  const [editing, setEditing] = useState<EditState | null>(null);

  // -----------------------------------------------------------------------
  // Zone types — backed by /admin/config/zone-types (ZoneTypeMeta table).
  // -----------------------------------------------------------------------
  const zoneTypesQuery = useQuery({
    queryKey: ['admin', 'zone-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/zone-types').then((r) => r.data?.data ?? r.data),
    enabled: activeTab === 'zone',
  });

  const updateZoneType = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; label?: string; color?: string; icon?: string | null; sortOrder?: number }) =>
      client.patch(`/admin/config/zone-types/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-types'] });
      notify.success('Zone type updated', { code: 'ZONETYPE-UPDATE-200' });
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update zone type'),
  });

  const deleteZoneType = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/zone-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'zone-types'] });
      notify.success('Zone type deleted', { code: 'ZONETYPE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone type'),
  });

  // -----------------------------------------------------------------------
  // Project Categories queries — the SAME table (`project_types`) the
  // New-Project dropdown reads via useProjectTypes(). Adding/renaming
  // here has to be visible in /projects/new after refresh.
  // -----------------------------------------------------------------------
  const projectCategoriesQuery = useQuery({
    queryKey: ['admin', 'project-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/project-types').then((r) => r.data?.data ?? r.data),
    enabled: activeTab === 'projectCategory',
  });

  const createProjectCategory = useMutation({
    mutationFn: (payload: { name: string; code?: string; color?: string }) =>
      client.post('/admin/config/project-types', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      // Also invalidate the New-Project form's useProjectTypes() so a
      // newly created category shows up there without a hard refresh.
      queryClient.invalidateQueries({ queryKey: ['projectTypes'] });
      notify.success('Project category created', { code: 'PROJCAT-CREATE-200' });
      resetForm();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create project category'),
  });

  const updateProjectCategory = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name: string; code?: string; color?: string }) =>
      client.patch(`/admin/config/project-types/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      queryClient.invalidateQueries({ queryKey: ['projectTypes'] });
      notify.success('Project category updated', { code: 'PROJCAT-UPDATE-200' });
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update project category'),
  });

  const deleteProjectCategory = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/project-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      queryClient.invalidateQueries({ queryKey: ['projectTypes'] });
      notify.success('Project category deleted', { code: 'PROJCAT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete project category'),
  });

  // -----------------------------------------------------------------------
  // Service types queries
  // -----------------------------------------------------------------------
  const serviceTypesQuery = useQuery({
    queryKey: ['service-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/service-types').then((r) => r.data.data ?? r.data),
    enabled: activeTab === 'service',
  });

  const createServiceType = useMutation({
    mutationFn: (payload: { name: string; code?: string; color?: string }) =>
      client.post('/service-types', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types'] });
      notify.success('Service type created', { code: 'SVCTYPE-CREATE-200' });
      resetForm();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create service type'),
  });

  const updateServiceType = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name: string; code?: string; color?: string }) =>
      client.patch(`/service-types/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types'] });
      notify.success('Service type updated', { code: 'SVCTYPE-UPDATE-200' });
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update service type'),
  });

  const deleteServiceType = useMutation({
    mutationFn: (id: number) => client.delete(`/service-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types'] });
      notify.success('Service type deleted', { code: 'SVCTYPE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete service type'),
  });

  // Project types + Project roles blocks removed (was: unfinished
  // feature — queries were gated on `activeTab === 'project'` /
  // 'projectRole' but neither key exists on TabKey, and the query
  // results/mutations were never referenced anywhere in the render.
  // Cleaning the dead code lets tsc pass; the /admin/config/project-*
  // endpoints stay on the server for when this feature ships.)

  // -----------------------------------------------------------------------
  // Departments queries
  // -----------------------------------------------------------------------
  const departmentsQuery = useQuery({
    queryKey: ['admin', 'departments'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
    enabled: activeTab === 'department',
  });

  const createDepartment = useMutation({
    mutationFn: (payload: { name: string; code?: string }) =>
      client.post('/admin/config/departments', payload).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'departments'] }); notify.success('Department created'); resetForm(); },
    onError: (err: any) => notify.apiError(err, 'Failed to create department'),
  });

  const updateDepartment = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name?: string; code?: string }) =>
      client.patch(`/admin/config/departments/${id}`, payload).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'departments'] }); notify.success('Department updated'); setEditing(null); },
    onError: (err: any) => notify.apiError(err, 'Failed to update department'),
  });

  const deleteDepartment = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/departments/${id}`).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'departments'] }); notify.success('Department deleted'); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete department'),
  });

  // -----------------------------------------------------------------------
  // Professions queries
  // -----------------------------------------------------------------------
  const professionsQuery = useQuery({
    queryKey: ['admin', 'professions'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/professions').then((r) => { const d = r.data?.data ?? r.data; return Array.isArray(d) ? d : []; }),
    enabled: activeTab === 'profession',
  });

  const createProfession = useMutation({
    mutationFn: (payload: { name: string }) =>
      client.post('/admin/config/professions', payload).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'professions'] }); notify.success('Job title created'); resetForm(); },
    onError: (err: any) => notify.apiError(err, 'Failed to create profession'),
  });

  const updateProfession = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name?: string }) =>
      client.patch(`/admin/config/professions/${id}`, payload).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'professions'] }); notify.success('Job title updated'); setEditing(null); },
    onError: (err: any) => notify.apiError(err, 'Failed to update profession'),
  });

  const deleteProfession = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/professions/${id}`).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'professions'] }); notify.success('Qualification deleted'); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete qualification'),
  });

  // -----------------------------------------------------------------------
  // Positions (JT-3) — descriptive-title catalog. Backed by
  // `/admin/config/positions` (Position model, seeded by migration
  // 20260929210000_seed_positions with CEO / VP / HR manager / Finance).
  // Same shared cache key as the drawer + People edit modal so writes
  // here immediately reflect in those pickers.
  // -----------------------------------------------------------------------
  const positionsQuery = useQuery({
    queryKey: ['admin', 'config', 'positions'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/positions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
    enabled: activeTab === 'position',
  });

  const createPosition = useMutation({
    mutationFn: (payload: { name: string; code?: string }) =>
      client.post('/admin/config/positions', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'config', 'positions'] });
      notify.success('Position created');
      resetForm();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create position'),
  });

  const updatePosition = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name?: string; code?: string }) =>
      client.patch(`/admin/config/positions/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'config', 'positions'] });
      notify.success('Position updated');
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update position'),
  });

  const deletePosition = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/positions/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'config', 'positions'] });
      notify.success('Position deleted');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete position'),
  });

  // (Project roles block was here; removed for the same reason as
  // the Project types block above — dead code that never rendered.)

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function resetForm() {
    setShowForm(false);
    setFormName('');
    setFormCode('');
    setFormColor('');
  }

  const isLoading =
    (activeTab === 'zone' && zoneTypesQuery.isLoading) ||
    (activeTab === 'projectCategory' && projectCategoriesQuery.isLoading) ||
    (activeTab === 'service' && serviceTypesQuery.isLoading) ||
    (activeTab === 'department' && departmentsQuery.isLoading) ||
    (activeTab === 'profession' && professionsQuery.isLoading) ||
    (activeTab === 'position' && positionsQuery.isLoading);

  const isCreating =
    (activeTab === 'projectCategory' && createProjectCategory.isPending) ||
    (activeTab === 'service' && createServiceType.isPending) ||
    (activeTab === 'department' && createDepartment.isPending) ||
    (activeTab === 'profession' && createProfession.isPending) ||
    (activeTab === 'position' && createPosition.isPending);

  const isSaving =
    updateZoneType.isPending ||
    updateProjectCategory.isPending ||
    updateServiceType.isPending ||
    updateDepartment.isPending ||
    updateProfession.isPending ||
    updatePosition.isPending;

  // Build the rows for the active tab
  const rows: { id: string | number; code: string; name: string; color?: string; static?: boolean; sortOrder?: number }[] =
    useMemo(() => {
      const q = search.toLowerCase().trim();

      let items: typeof rows = [];
      if (activeTab === 'zone') {
        items = (zoneTypesQuery.data ?? []).map((z: any) => ({
          id: z.id,
          code: (z.code ?? '').toString().toUpperCase(),
          name: z.label ?? z.code ?? '',
          color: z.color ?? '',
          sortOrder: z.sortOrder ?? 0,
        }));
      } else if (activeTab === 'projectCategory') {
        items = (projectCategoriesQuery.data ?? []).map((c: any) => ({
          id: c.id, code: c.code ?? '', name: c.name, color: c.color ?? '',
        }));
      } else if (activeTab === 'service') {
        items = (serviceTypesQuery.data ?? []).map((s: any) => ({
          id: s.id, code: s.code ?? '', name: s.name, color: s.color ?? '',
        }));
      } else if (activeTab === 'department') {
        items = (departmentsQuery.data ?? []).map((d: any, idx: number) => ({
          id: d.id, code: '', name: d.name, sortOrder: d.sortOrder ?? idx + 1,
        }));
      } else if (activeTab === 'profession') {
        items = (professionsQuery.data ?? []).map((p: any) => ({
          id: p.id, code: '', name: p.name,
        }));
      } else if (activeTab === 'position') {
        items = (positionsQuery.data ?? []).map((p: any) => ({
          id: p.id,
          code: (p.code ?? '').toString(),
          name: p.nameHe ? `${p.name} · ${p.nameHe}` : p.name,
        }));
      }

      if (!q) return items;
      return items.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q),
      );
    }, [activeTab, search, zoneTypesQuery.data, projectCategoriesQuery.data, serviceTypesQuery.data, departmentsQuery.data, professionsQuery.data, positionsQuery.data]);

  const hasColor = activeTab === 'zone' || activeTab === 'projectCategory' || activeTab === 'service';
  const hasCode = activeTab === 'zone' || activeTab === 'projectCategory' || activeTab === 'service' || activeTab === 'department' || activeTab === 'position';
  const hasNumbering = activeTab === 'department';

  // -----------------------------------------------------------------------
  // Inline edit handlers
  // -----------------------------------------------------------------------
  function startEditing(row: (typeof rows)[number]) {
    setEditing({
      id: row.id,
      name: row.name,
      code: row.code,
      color: row.color || '',
    });
  }

  function cancelEditing() {
    setEditing(null);
  }

  // People UX M2d (E-08) — usage-count helper for the two catalogs
  // whose values are stored as plain strings on User rows (department,
  // position). Falls back to zero on any error so the confirm still
  // renders without the warning line rather than blocking the rename /
  // delete altogether.
  async function fetchUsage(kind: 'department' | 'profession', id: number): Promise<number> {
    const path = kind === 'department'
      ? `/admin/config/departments/${id}/usage`
      : `/admin/config/professions/${id}/usage`;
    try {
      const res = await client.get(path);
      const data = res.data?.data ?? res.data;
      return Number(data?.userCount ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  const saveEditing = useCallback(async () => {
    if (!editing) return;
    const trimmedName = editing.name.trim();
    if (!trimmedName) {
      notify.warning('Name is required');
      return;
    }

    if (activeTab === 'zone') {
      // Zone Types map to ZoneTypeMeta — `name` is the user-facing
      // `label` field, `code` (the enum slug) is read-only.
      updateZoneType.mutate({
        id: editing.id as number,
        label: trimmedName,
        color: editing.color.trim() || undefined,
      });
    } else if (activeTab === 'projectCategory') {
      updateProjectCategory.mutate({ id: editing.id as number, name: trimmedName, code: editing.code.trim() || undefined, color: editing.color.trim() || undefined });
    } else if (activeTab === 'service') {
      updateServiceType.mutate({ id: editing.id as number, name: trimmedName, code: editing.code.trim() || undefined, color: editing.color.trim() || undefined });
    } else if (activeTab === 'department' || activeTab === 'profession') {
      // People UX M2d (E-08) — rename touches the value stored on
      // every referencing User row (server updates the catalog name;
      // the plain-string on User.department / User.position is
      // implicitly aliased through the display until Stage 2's OrgUnit
      // lift). Warn when > 0 employees will read the new name so the
      // admin sees the blast radius before confirming.
      const kind = activeTab;
      const original = rows.find((r) => r.id === editing.id)?.name ?? '';
      // Only ask when the name is actually changing — a plain save
      // (e.g. sortOrder / code tweak) doesn't need the warning.
      if (trimmedName !== original) {
        const count = await fetchUsage(kind, editing.id as number);
        if (count > 0) {
          const label = kind === 'department' ? 'department' : 'job title';
          const ok = await confirm(
            `${count} ${count === 1 ? 'employee' : 'employees'} use "${original}" as their ${label} — they'll see the new name "${trimmedName}" everywhere.`,
            {
              title: `Rename ${label} to "${trimmedName}"?`,
              variant: 'default',
              confirmLabel: 'Rename',
            },
          );
          if (!ok) return;
        }
      }
      // NOTE: `kind` here is 'department' | 'profession' — the position
      // branch is handled below because Positions use the `positions`
      // catalog (not `professions`) and don't need the E-08 warning
      // (User.position → BP.positionId sync is idempotent).
      if (kind === 'department') {
        updateDepartment.mutate({ id: editing.id as number, name: trimmedName, code: editing.code.trim() || undefined });
      } else {
        updateProfession.mutate({ id: editing.id as number, name: trimmedName });
      }
    } else if (activeTab === 'position') {
      updatePosition.mutate({
        id: editing.id as number,
        name: trimmedName,
        code: editing.code.trim() || undefined,
      });
    }
  }, [editing, activeTab, updateZoneType, updateProjectCategory, updateServiceType, updateDepartment, updateProfession, updatePosition, confirm, rows]);

  // Escape key handler for inline edit
  useEffect(() => {
    if (!editing) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        cancelEditing();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editing]);

  // -----------------------------------------------------------------------
  // Form submit
  // -----------------------------------------------------------------------
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = formName.trim();
    if (!trimmedName) return;

    if (activeTab === 'projectCategory') {
      createProjectCategory.mutate({ name: trimmedName, code: formCode.trim() || undefined, color: formColor.trim() || undefined });
    } else if (activeTab === 'service') {
      createServiceType.mutate({ name: trimmedName, code: formCode.trim() || undefined, color: formColor.trim() || undefined });
    } else if (activeTab === 'department') {
      createDepartment.mutate({ name: trimmedName, code: formCode.trim() || undefined });
    } else if (activeTab === 'profession') {
      createProfession.mutate({ name: trimmedName });
    } else if (activeTab === 'position') {
      // Auto-slug the code from the name when the admin didn't supply
      // one — matches how the backend seed rows are keyed (ceo /
      // hr-manager / …). Non-Latin characters fall through and the
      // backend enforces uniqueness.
      const slug = formCode.trim() || trimmedName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      createPosition.mutate({ name: trimmedName, code: slug || undefined });
    }
  }

  async function handleDelete(row: (typeof rows)[number]) {
    if (row.static) return;
    // People UX U2 — catalog delete: danger variant + verb button, and a
    // concrete description so the operator understands what happens to
    // records still referencing this catalog row.
    const kind =
      activeTab === 'department' ? 'department'
      : activeTab === 'profession' ? 'qualification'
      : activeTab === 'position' ? 'position'
      : activeTab === 'zone' ? 'zone type'
      : activeTab === 'projectCategory' ? 'project category'
      : activeTab === 'service' ? 'service type'
      : 'item';
    // People UX M2d (E-08) — for the two tabs whose values are stored as
    // plain strings on Users, pull the referencing count and inject a
    // "N employees use this — they'll lose it" line into the confirm.
    // Falls back to the generic message for the other catalogs (whose
    // FKs are already enforced at the DB level).
    let extraLine = '';
    if (activeTab === 'department' || activeTab === 'profession') {
      const count = await fetchUsage(activeTab, row.id as number);
      if (count > 0) {
        extraLine = `\n\n${count} ${count === 1 ? 'employee uses' : 'employees use'} this ${kind} — after delete they'll show it as legacy until an admin picks a live value on their profile.`;
      }
    }
    const ok = await confirm(
      `Existing records referencing this ${kind} keep it as legacy data; new records will pick from the remaining catalog.${extraLine}`,
      {
        title: `Delete ${kind} "${row.name}"?`,
        variant: 'danger',
        confirmLabel: 'Delete',
      },
    );
    if (!ok) return;

    if (activeTab === 'zone') deleteZoneType.mutate(row.id as number);
    else if (activeTab === 'projectCategory') deleteProjectCategory.mutate(row.id as number);
    else if (activeTab === 'service') deleteServiceType.mutate(row.id as number);
    else if (activeTab === 'department') deleteDepartment.mutate(row.id as number);
    else if (activeTab === 'profession') deleteProfession.mutate(row.id as number);
    else if (activeTab === 'position') deletePosition.mutate(row.id as number);
  }

  // -----------------------------------------------------------------------
  // Resolve color string to a valid CSS value
  // -----------------------------------------------------------------------
  function resolveColor(color?: string): string | undefined {
    if (!color) return undefined;
    const c = color.trim();
    if (!c) return undefined;
    return c.startsWith('#') ? c : `#${c}`;
  }

  // Zone Types: editable + deletable (via ZoneTypeMeta) but NOT addable
  // — new values would require a Prisma enum migration. Other tabs are
  // fully mutable.
  const canAdd = activeTab !== 'zone';
  const canDelete = true;
  const isSimpleList = activeTab === 'profession';
  const addLabel =
    activeTab === 'department' ? 'Add Department' :
    activeTab === 'profession' ? 'Add Job Title' :
    activeTab === 'projectCategory' ? 'Add Category' :
    activeTab === 'service' ? 'Add Service' :
    'Add Type';

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-2 py-6">
      {/* Back link */}
      <button
        onClick={() => navigate('/templates')}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Templates
      </button>

      {/* Page title */}
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Types & Categories</h1>
        <p className="mt-1 text-[13px] text-slate-400 dark:text-slate-500">
          Manage types, departments, professions, and project roles
        </p>
      </div>

      {/* Tabs — People UX M5 (E-20 / E-27). Shared component renders
          role=tablist/tab, aria-selected, arrow-key navigation, and mirrors
          the active tab to `?tab=` in the URL via useUrlTab above. */}
      <Tabs
        idBase="templates-types"
        ariaLabel="Types and categories sub-views"
        value={activeTab}
        onChange={(next) => {
          setActiveTabRaw(next);
          // Preserve original side-effects on tab switch: clear the
          // search box and any in-progress add / inline edit so the
          // new tab lands in a clean state.
          setSearch('');
          resetForm();
          setEditing(null);
        }}
        items={TABS}
      />

      {/* Card — wraps the tab's content as the tabpanel paired with the
          shared Tabs component above. */}
      <div
        role="tabpanel"
        id={tabPanelId('templates-types', activeTab)}
        aria-labelledby={tabTriggerId('templates-types', activeTab)}
        className="bg-white dark:bg-slate-900 rounded-[14px] border border-slate-200 dark:border-slate-700 overflow-hidden"
      >
        {/* Toolbar: search + add button */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300 dark:text-slate-600" />
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          {canAdd && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              {addLabel}
            </button>
          )}
        </div>

        {/* Inline add form */}
        {showForm && canAdd && (
          <form
            onSubmit={handleSubmit}
            className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 px-5 py-4"
          >
            <div className={`grid grid-cols-1 ${isSimpleList ? 'sm:grid-cols-[1fr]' : hasColor ? 'sm:grid-cols-[1fr_120px_160px]' : 'sm:grid-cols-[1fr_120px]'} gap-3 items-end`}>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
                  Name <span className="text-red-400">*</span>
                </label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={
                    activeTab === 'projectCategory' ? 'e.g. מגורים, Buildings, Infrastructure' :
                    activeTab === 'service' ? 'e.g. BIM Coordination, MEP, Structural' :
                    activeTab === 'department' ? 'e.g. Buildings, VDC' :
                    activeTab === 'profession' ? 'e.g. Architect, MEP Engineer' :
                    'e.g. Civil Engineering'
                  }
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              {!isSimpleList && (
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Code</label>
                  <input
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    placeholder="e.g. BIM"
                    maxLength={10}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              )}
              {hasColor && (
                <div>
                  <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Color</label>
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 focus-within:border-blue-500">
                    <span className="inline-block h-3.5 w-3.5 rounded-full shrink-0 border border-slate-200 dark:border-slate-700" style={{ backgroundColor: resolveColor(formColor) ?? '#CBD5E1' }} />
                    <span className="text-sm text-slate-400 dark:text-slate-500">#</span>
                    <input value={formColor} onChange={(e) => setFormColor(e.target.value.replace(/^#/, ''))} placeholder="3B82F6" maxLength={7} className="flex-1 text-sm text-slate-700 dark:text-slate-200 focus:outline-none bg-transparent" />
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button type="submit" disabled={isCreating} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
                {isCreating ? 'Creating...' : 'Create'}
              </button>
              <button type="button" onClick={resetForm} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="p-5">
            <TableSkeleton rows={5} cols={hasColor ? 5 : 4} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            title={search
              ? 'No types match your search'
              : `No ${TABS.find((t) => t.value === activeTab)?.label?.toLowerCase()} configured yet`}
            description={search ? 'Try a different name.' : undefined}
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-[#FAFBFC]">
                {hasColor && (
                  <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em] w-14">Color</th>
                )}
                {hasNumbering && (
                  <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em] w-14">#</th>
                )}
                {hasCode && !hasNumbering && (
                  <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em] w-28">Code</th>
                )}
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">
                  {activeTab === 'department' ? 'Department Name' :
                   activeTab === 'profession' ? 'Job Title Name' :
                   activeTab === 'projectCategory' ? 'Category Name' :
                   activeTab === 'service' ? 'Service Name' :
                   'Name'}
                </th>
                <th className="px-5 py-2.5 text-right text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em] w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                const isEditing = editing?.id === row.id;

                if (isEditing && editing) {
                  return (
                    <tr key={row.id} className="text-[13px] bg-blue-50/30 border-t border-slate-100 dark:border-slate-800">
                      {hasColor && (
                        <td className="px-5 py-2.5">
                          <ColorInput value={editing.color} onChange={(v) => setEditing({ ...editing, color: v })} />
                        </td>
                      )}
                      {hasNumbering && (
                        <td className="px-5 py-2.5 text-slate-400 dark:text-slate-500 font-medium">{rowIdx + 1}</td>
                      )}
                      {hasCode && !hasNumbering && (
                        <td className="px-5 py-2.5">
                          <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); if (e.key === 'Escape') cancelEditing(); }}
                            maxLength={10} placeholder="CODE" disabled={activeTab === 'zone'}
                            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400" />
                        </td>
                      )}
                      <td className="px-5 py-2.5">
                        <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); if (e.key === 'Escape') cancelEditing(); }}
                          placeholder="Name"
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                          autoFocus />
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={saveEditing} disabled={isSaving}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50" title="Save">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={cancelEditing}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={row.id} onClick={() => startEditing(row)}
                    className="text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 transition-colors cursor-pointer">
                    {hasColor && (
                      <td className="px-5 py-3">
                        {resolveColor(row.color) ? (
                          <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: resolveColor(row.color) }} />
                        ) : (
                          <span className="inline-block h-3 w-3 rounded-full bg-slate-200 dark:bg-slate-700" />
                        )}
                      </td>
                    )}
                    {hasNumbering && (
                      <td className="px-5 py-3 text-slate-500 dark:text-slate-400 font-medium">{rowIdx + 1}</td>
                    )}
                    {hasCode && !hasNumbering && (
                      <td className="px-5 py-3">
                        {row.code ? (
                          <span className="rounded-[5px] bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 text-[11px] font-bold tracking-wide px-2 py-0.5">{row.code}</span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">--</span>
                        )}
                      </td>
                    )}
                    <td className="px-5 py-3 font-medium text-slate-700 dark:text-slate-200">{row.name}</td>
                    <td className="px-5 py-3 text-right">
                      {canDelete && (
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
                          className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-red-50 text-slate-300 dark:text-slate-600 hover:text-red-600 transition-colors" title={`Delete ${row.name}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Footer count */}
        {!isLoading && rows.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-[#FAFBFC]">
            <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 tracking-wide">
              {rows.length} {rows.length === 1 ? 'type' : 'types'}
              {search && ' matching'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
