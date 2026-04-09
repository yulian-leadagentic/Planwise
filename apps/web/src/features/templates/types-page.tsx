import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus, Search, Trash2, X } from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// ---------------------------------------------------------------------------
// Static zone types (enum-based, not stored in DB)
// ---------------------------------------------------------------------------
const ZONE_TYPES = [
  { id: 'site', code: 'SITE', name: 'Site', color: '#6366F1' },
  { id: 'building', code: 'BLD', name: 'Building', color: '#3B82F6' },
  { id: 'level', code: 'LVL', name: 'Level', color: '#0EA5E9' },
  { id: 'floor', code: 'FLR', name: 'Floor', color: '#14B8A6' },
  { id: 'zone', code: 'ZONE', name: 'Zone', color: '#22C55E' },
  { id: 'area', code: 'AREA', name: 'Area', color: '#EAB308' },
  { id: 'section', code: 'SEC', name: 'Section', color: '#F97316' },
  { id: 'wing', code: 'WING', name: 'Wing', color: '#EC4899' },
];

// ---------------------------------------------------------------------------
// localStorage helpers for zone type colors
// ---------------------------------------------------------------------------
const ZONE_COLORS_KEY = 'planwise_zone_type_colors';

function loadZoneTypeColors(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ZONE_COLORS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveZoneTypeColors(colors: Record<string, string>) {
  localStorage.setItem(ZONE_COLORS_KEY, JSON.stringify(colors));
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
type TabKey = 'zone' | 'service' | 'project';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'zone', label: 'Zone Types' },
  { key: 'service', label: 'Service Types' },
  { key: 'project', label: 'Project Types' },
];

// ---------------------------------------------------------------------------
// Inline color input component
// ---------------------------------------------------------------------------
function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-4 h-4 rounded-full border border-slate-200 shrink-0"
        style={{ backgroundColor: value || '#6B7280' }}
      />
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#hex"
        className="w-20 px-2 py-1 rounded border border-slate-200 text-xs font-mono focus:border-blue-500 focus:outline-none"
      />
    </div>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<TabKey>('zone');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formColor, setFormColor] = useState('');

  // Inline edit state
  const [editing, setEditing] = useState<EditState | null>(null);

  // Zone type custom colors from localStorage
  const [zoneColors, setZoneColors] = useState<Record<string, string>>(loadZoneTypeColors);

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

  // -----------------------------------------------------------------------
  // Project types queries
  // -----------------------------------------------------------------------
  const projectTypesQuery = useQuery({
    queryKey: ['admin', 'project-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/project-types').then((r) => r.data.data),
    enabled: activeTab === 'project',
  });

  const createProjectType = useMutation({
    mutationFn: (payload: { name: string; code?: string; color?: string }) =>
      client.post('/admin/config/project-types', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      notify.success('Project type created', { code: 'PROJECT-CREATE-200' });
      resetForm();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create project type'),
  });

  const updateProjectType = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name: string; code?: string; color?: string }) =>
      client.patch(`/admin/config/project-types/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      notify.success('Project type updated', { code: 'PROJECT-UPDATE-200' });
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update project type'),
  });

  const deleteProjectType = useMutation({
    mutationFn: (id: number) =>
      client.delete(`/admin/config/project-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-types'] });
      notify.success('Project type deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete project type'),
  });

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
    (activeTab === 'service' && serviceTypesQuery.isLoading) ||
    (activeTab === 'project' && projectTypesQuery.isLoading);

  const isCreating =
    (activeTab === 'service' && createServiceType.isPending) ||
    (activeTab === 'project' && createProjectType.isPending);

  const isSaving =
    updateServiceType.isPending || updateProjectType.isPending;

  // Build the rows for the active tab
  const rows: { id: string | number; code: string; name: string; color?: string; static?: boolean }[] =
    useMemo(() => {
      const q = search.toLowerCase().trim();

      let items: typeof rows = [];
      if (activeTab === 'zone') {
        items = ZONE_TYPES.map((z) => ({
          ...z,
          color: zoneColors[z.id] || z.color,
          static: true,
        }));
      } else if (activeTab === 'service') {
        items = (serviceTypesQuery.data ?? []).map((s: any) => ({
          id: s.id,
          code: s.code ?? '',
          name: s.name,
          color: s.color ?? '',
        }));
      } else {
        items = (projectTypesQuery.data ?? []).map((p: any) => ({
          id: p.id,
          code: p.code ?? '',
          name: p.name,
          color: p.color ?? '',
        }));
      }

      if (!q) return items;
      return items.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q),
      );
    }, [activeTab, search, serviceTypesQuery.data, projectTypesQuery.data, zoneColors]);

  // All tabs now have color
  const hasColor = true;

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

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const trimmedName = editing.name.trim();
    if (!trimmedName) {
      notify.warning('Name is required');
      return;
    }

    if (activeTab === 'zone') {
      // Save zone color to localStorage
      const updated = { ...zoneColors };
      const defaultColor = ZONE_TYPES.find((z) => z.id === editing.id)?.color || '';
      if (editing.color && editing.color !== defaultColor) {
        updated[editing.id as string] = editing.color;
      } else if (!editing.color || editing.color === defaultColor) {
        delete updated[editing.id as string];
      }
      setZoneColors(updated);
      saveZoneTypeColors(updated);
      notify.success('Zone type color saved');
      setEditing(null);
    } else if (activeTab === 'service') {
      updateServiceType.mutate({
        id: editing.id as number,
        name: trimmedName,
        code: editing.code.trim() || undefined,
        color: editing.color.trim() || undefined,
      });
    } else if (activeTab === 'project') {
      updateProjectType.mutate({
        id: editing.id as number,
        name: trimmedName,
        code: editing.code.trim() || undefined,
        color: editing.color.trim() || undefined,
      });
    }
  }, [editing, activeTab, zoneColors, updateServiceType, updateProjectType]);

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

    if (activeTab === 'service') {
      createServiceType.mutate({
        name: trimmedName,
        code: formCode.trim() || undefined,
        color: formColor.trim() || undefined,
      });
    } else if (activeTab === 'project') {
      createProjectType.mutate({
        name: trimmedName,
        code: formCode.trim() || undefined,
        color: formColor.trim() || undefined,
      });
    }
  }

  function handleDelete(row: (typeof rows)[number]) {
    if (row.static) return;
    if (!confirm(`Delete "${row.name}"? This action cannot be undone.`)) return;

    if (activeTab === 'service') {
      deleteServiceType.mutate(row.id as number);
    } else if (activeTab === 'project') {
      deleteProjectType.mutate(row.id as number);
    }
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

  // Whether the active tab supports CRUD (delete/create)
  const isMutable = activeTab !== 'zone';

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-2 py-6">
      {/* Back link */}
      <button
        onClick={() => navigate('/templates')}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-400 hover:text-slate-600 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Templates
      </button>

      {/* Page title */}
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Types</h1>
        <p className="mt-1 text-[13px] text-slate-400">
          Manage zone types, service types, and project types
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              setSearch('');
              resetForm();
              setEditing(null);
            }}
            className={`pb-2.5 transition-colors ${
              activeTab === tab.key
                ? 'border-b-2 border-blue-600 text-blue-600 text-[13px] font-semibold'
                : 'border-b-2 border-transparent text-slate-400 text-[13px] font-semibold hover:text-slate-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Card */}
      <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
        {/* Toolbar: search + add button */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </div>
          {isMutable && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              Add Type
            </button>
          )}
        </div>

        {/* Inline add form */}
        {showForm && isMutable && (
          <form
            onSubmit={handleSubmit}
            className="border-b border-slate-100 bg-slate-50/60 px-5 py-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_160px] gap-3 items-end">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                  Name <span className="text-red-400">*</span>
                </label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={activeTab === 'service' ? 'e.g. BIM, MEP, Structural' : 'e.g. Civil Engineering'}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                  Code
                </label>
                <input
                  value={formCode}
                  onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                  placeholder="e.g. BIM"
                  maxLength={10}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">
                  Color
                </label>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 focus-within:border-blue-500">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full shrink-0 border border-slate-200"
                    style={{
                      backgroundColor: resolveColor(formColor) ?? '#CBD5E1',
                    }}
                  />
                  <span className="text-sm text-slate-400">#</span>
                  <input
                    value={formColor}
                    onChange={(e) => setFormColor(e.target.value.replace(/^#/, ''))}
                    placeholder="3B82F6"
                    maxLength={7}
                    className="flex-1 text-sm text-slate-700 focus:outline-none bg-transparent"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                type="submit"
                disabled={isCreating}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors"
              >
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
          <p className="py-12 text-center text-[13px] text-slate-400">
            {search
              ? 'No types match your search.'
              : `No ${TABS.find((t) => t.key === activeTab)?.label?.toLowerCase()} configured yet.`}
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-[#FAFBFC]">
                {hasColor && (
                  <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-14">
                    Color
                  </th>
                )}
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-28">
                  Code
                </th>
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
                  Name
                </th>
                <th className="px-5 py-2.5 text-right text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-28">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditing = editing?.id === row.id;

                if (isEditing && editing) {
                  return (
                    <tr
                      key={row.id}
                      className="text-[13px] bg-blue-50/30 border-t border-slate-100"
                    >
                      {hasColor && (
                        <td className="px-5 py-2.5">
                          <ColorInput
                            value={editing.color}
                            onChange={(v) => setEditing({ ...editing, color: v })}
                          />
                        </td>
                      )}
                      <td className="px-5 py-2.5">
                        <input
                          value={editing.code}
                          onChange={(e) =>
                            setEditing({ ...editing, code: e.target.value.toUpperCase() })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEditing();
                            if (e.key === 'Escape') cancelEditing();
                          }}
                          maxLength={10}
                          placeholder="CODE"
                          disabled={activeTab === 'zone'}
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                        />
                      </td>
                      <td className="px-5 py-2.5">
                        <input
                          value={editing.name}
                          onChange={(e) =>
                            setEditing({ ...editing, name: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEditing();
                            if (e.key === 'Escape') cancelEditing();
                          }}
                          placeholder="Name"
                          disabled={activeTab === 'zone'}
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                          autoFocus
                        />
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={saveEditing}
                            disabled={isSaving}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                            title="Save"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={cancelEditing}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                            title="Cancel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr
                    key={row.id}
                    onClick={() => startEditing(row)}
                    className="text-[13px] hover:bg-slate-50 border-t border-slate-100 transition-colors cursor-pointer"
                  >
                    {hasColor && (
                      <td className="px-5 py-3">
                        {resolveColor(row.color) ? (
                          <span
                            className="inline-block h-3 w-3 rounded-full"
                            style={{ backgroundColor: resolveColor(row.color) }}
                          />
                        ) : (
                          <span className="inline-block h-3 w-3 rounded-full bg-slate-200" />
                        )}
                      </td>
                    )}
                    <td className="px-5 py-3">
                      {row.code ? (
                        <span className="rounded-[5px] bg-slate-50 text-slate-600 text-[11px] font-bold tracking-wide px-2 py-0.5">
                          {row.code}
                        </span>
                      ) : (
                        <span className="text-slate-300">--</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-700">{row.name}</td>
                    <td className="px-5 py-3 text-right">
                      {isMutable ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(row);
                          }}
                          className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-red-50 text-slate-300 hover:text-red-600 transition-colors"
                          title={`Delete ${row.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : (
                        <span className="rounded-[5px] bg-slate-50 text-slate-400 text-[11px] font-bold tracking-wide px-2 py-0.5">
                          Static
                        </span>
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
          <div className="px-5 py-3 border-t border-slate-100 bg-[#FAFBFC]">
            <span className="text-[11px] font-semibold text-slate-400 tracking-wide">
              {rows.length} {rows.length === 1 ? 'type' : 'types'}
              {search && ' matching'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
