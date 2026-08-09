import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus, Search, Trash2, X, Palette } from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';

interface EditState {
  id: number;
  name: string;
  code: string;
  color: string;
}

interface CreateFormState {
  name: string;
  code: string;
  color: string;
}

const emptyCreate: CreateFormState = { name: '', code: '', color: '' };

function resolveColor(c?: string | null): string | undefined {
  if (!c) return undefined;
  const v = c.trim();
  if (!v) return undefined;
  return v.startsWith('#') ? v : `#${v}`;
}

export function PhasesPage() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(emptyCreate);
  const [editing, setEditing] = useState<EditState | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['phases'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/phases').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; code?: string; color?: string }) =>
      client.post('/phases', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phases'] });
      notify.success('Service created');
      resetForm();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name?: string; code?: string; color?: string }) =>
      client.patch(`/phases/${id}`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phases'] });
      notify.success('Service updated');
      setEditing(null);
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/phases/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phases'] });
      notify.success('Service deleted');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  function resetForm() {
    setShowForm(false);
    setCreateForm(emptyCreate);
  }

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const trimmedName = editing.name.trim();
    if (!trimmedName) { notify.warning('Name is required'); return; }
    updateMutation.mutate({
      id: editing.id,
      name: trimmedName,
      code: editing.code.trim() || undefined,
      color: editing.color.trim() || undefined,
    });
  }, [editing, updateMutation]);

  // Escape cancels the ambient inline edit — kept from the previous
  // hand-rolled version so keyboard users don't lose the shortcut.
  useEffect(() => {
    if (!editing) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setEditing(null);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = createForm.name.trim();
    if (!trimmedName) return;
    createMutation.mutate({
      name: trimmedName,
      code: createForm.code.trim() || undefined,
      color: createForm.color.trim() || undefined,
    });
  };

  const rows = useMemo(() => {
    const items: any[] = data ?? [];
    const q = search.toLowerCase().trim();
    if (!q) return items;
    return items.filter((r: any) =>
      r.name.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q),
    );
  }, [data, search]);

  const columns = useMemo<ColumnDef<any, unknown>[]>(() => [
    { id: 'color', header: 'Color', enableSorting: false, size: 64,
      cell: ({ row }) => {
        const resolved = resolveColor(row.original.color);
        return resolved
          ? <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: resolved }} />
          : <span className="inline-block h-3 w-3 rounded-full bg-slate-200 dark:bg-slate-700" />;
      } },
    { accessorKey: 'code', header: 'Code', enableSorting: false, size: 112,
      cell: ({ row }) => (
        row.original.code
          ? <span className="rounded-[5px] bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 text-[11px] font-bold tracking-wide px-2 py-0.5">{row.original.code}</span>
          : <span className="text-slate-300 dark:text-slate-600">—</span>
      ) },
    { accessorKey: 'name', header: 'Service Name', enableSorting: false,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { id: 'actions', header: 'Actions', enableSorting: false, size: 112,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing({ id: row.original.id, name: row.original.name, code: row.original.code ?? '', color: row.original.color ?? '' });
              setShowForm(false);
            }}
            aria-label={`Edit ${row.original.name}`}
            className="text-xs text-blue-600 hover:underline"
          >
            Edit
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (await confirm(`Delete "${row.original.name}"?`)) deleteMutation.mutate(row.original.id);
            }}
            aria-label={`Delete ${row.original.name}`}
            className="ml-2 inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
          </button>
        </div>
      ) },
  ], [confirm, deleteMutation]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-2 py-6">
      <button onClick={() => navigate('/templates')}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Templates
      </button>

      <PageHeader
        title="Services"
        description="Manage services with color coding for visual identification across the app"
        actions={
          !showForm && !editing ? (
            <button
              onClick={() => { setShowForm(true); setEditing(null); }}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add Service
            </button>
          ) : null
        }
      />

      {/* Create form — hoisted above the DataTable (was previously an
          inline row inside the shared card). */}
      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_160px] gap-3 items-end">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Name <span className="text-red-400">*</span></label>
              <input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="e.g. BIM Coordination, MEP"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none" autoFocus />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Code</label>
              <input value={createForm.code} onChange={(e) => setCreateForm({ ...createForm, code: e.target.value.toUpperCase() })} placeholder="e.g. BIM" maxLength={10}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Color</label>
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 focus-within:border-blue-500 bg-background">
                <span className="inline-block h-3.5 w-3.5 rounded-full shrink-0 border border-slate-200 dark:border-slate-700" style={{ backgroundColor: resolveColor(createForm.color) ?? '#CBD5E1' }} />
                <span className="text-sm text-slate-400 dark:text-slate-500">#</span>
                <input value={createForm.color} onChange={(e) => setCreateForm({ ...createForm, color: e.target.value.replace(/^#/, '') })} placeholder="3B82F6" maxLength={7}
                  className="flex-1 text-sm text-slate-700 dark:text-slate-200 focus:outline-none bg-transparent" />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={resetForm}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Edit form — hoisted above the DataTable in the same slot the
          click-a-row-to-edit used to render an inline edit row. */}
      {editing && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-blue-50/30 dark:bg-blue-950/30 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_160px] gap-3 items-end">
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Name <span className="text-red-400">*</span></label>
              <input value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); }}
                placeholder="Name" autoFocus
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Code</label>
              <input value={editing.code}
                onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); }}
                maxLength={10} placeholder="CODE"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Color</label>
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 focus-within:border-blue-500 bg-background">
                <span className="inline-block h-3.5 w-3.5 rounded-full shrink-0 border border-slate-200 dark:border-slate-700" style={{ backgroundColor: resolveColor(editing.color) || '#6B7280' }} />
                <input value={editing.color}
                  onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                  placeholder="#hex"
                  className="flex-1 text-sm text-slate-700 dark:text-slate-200 focus:outline-none bg-transparent" />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={saveEditing} disabled={updateMutation.isPending}
              className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Save
            </button>
            <button type="button" onClick={() => setEditing(null)}
              className="inline-flex items-center gap-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors">
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search stays above the table (was toolbar-inside-card previously). */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300 dark:text-slate-600" aria-hidden="true" />
        <input type="text" placeholder="Search services..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-background text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
          aria-label="Search services" />
      </div>

      {isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Palette}
          title={search ? 'No services match your search' : 'No services configured yet'}
          description={search ? 'Try a different name or code.' : 'Add a service (e.g. BIM Coordination, MEP) to start tagging tasks and templates.'}
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          pageSize={1000}
          onRowClick={(row: any) => {
            setEditing({ id: row.id, name: row.name, code: row.code ?? '', color: row.color ?? '' });
            setShowForm(false);
          }}
        />
      )}
    </div>
  );
}
