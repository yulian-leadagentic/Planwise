import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus, Search, Trash2, X } from 'lucide-react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

interface EditState {
  id: number;
  name: string;
  code: string;
  color: string;
}

function resolveColor(c?: string | null): string | undefined {
  if (!c) return undefined;
  const v = c.trim();
  if (!v) return undefined;
  return v.startsWith('#') ? v : `#${v}`;
}

export function PhasesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formColor, setFormColor] = useState('');
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
    setFormName('');
    setFormCode('');
    setFormColor('');
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
    const trimmedName = formName.trim();
    if (!trimmedName) return;
    createMutation.mutate({
      name: trimmedName,
      code: formCode.trim() || undefined,
      color: formColor.trim() || undefined,
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-2 py-6">
      {/* Back link */}
      <button onClick={() => navigate('/templates')}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-400 hover:text-slate-600 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Templates
      </button>

      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Services</h1>
        <p className="mt-1 text-[13px] text-slate-400">Manage services with color coding for visual identification across the app</p>
      </div>

      {/* Card */}
      <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
            <input type="text" placeholder="Search services..." value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
          </div>
          <button onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors whitespace-nowrap">
            <Plus className="h-4 w-4" /> Add Service
          </button>
        </div>

        {/* Inline add form */}
        {showForm && (
          <form onSubmit={handleSubmit} className="border-b border-slate-100 bg-slate-50/60 px-5 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_160px] gap-3 items-end">
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Name <span className="text-red-400">*</span></label>
                <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. BIM Coordination, MEP"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Code</label>
                <input value={formCode} onChange={(e) => setFormCode(e.target.value.toUpperCase())} placeholder="e.g. BIM" maxLength={10}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Color</label>
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 focus-within:border-blue-500">
                  <span className="inline-block h-3.5 w-3.5 rounded-full shrink-0 border border-slate-200" style={{ backgroundColor: resolveColor(formColor) ?? '#CBD5E1' }} />
                  <span className="text-sm text-slate-400">#</span>
                  <input value={formColor} onChange={(e) => setFormColor(e.target.value.replace(/^#/, ''))} placeholder="3B82F6" maxLength={7}
                    className="flex-1 text-sm text-slate-700 focus:outline-none bg-transparent" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="submit" disabled={createMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </button>
              <button type="button" onClick={resetForm}
                className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="p-5"><TableSkeleton rows={5} cols={4} /></div>
        ) : rows.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-slate-400">
            {search ? 'No services match your search.' : 'No services configured yet.'}
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-[#FAFBFC]">
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-14">Color</th>
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-28">Code</th>
                <th className="px-5 py-2.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">Service Name</th>
                <th className="px-5 py-2.5 text-right text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => {
                const isEditing = editing?.id === row.id;

                if (isEditing && editing) {
                  return (
                    <tr key={row.id} className="text-[13px] bg-blue-50/30 border-t border-slate-100">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="w-4 h-4 rounded-full border border-slate-200 shrink-0"
                            style={{ backgroundColor: resolveColor(editing.color) || '#6B7280' }} />
                          <input type="text" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })}
                            placeholder="#hex" className="w-20 px-2 py-1 rounded border border-slate-200 text-xs font-mono focus:border-blue-500 focus:outline-none" />
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); if (e.key === 'Escape') setEditing(null); }}
                          maxLength={10} placeholder="CODE"
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
                      </td>
                      <td className="px-5 py-2.5">
                        <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEditing(); if (e.key === 'Escape') setEditing(null); }}
                          placeholder="Name"
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                          autoFocus />
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={saveEditing} disabled={updateMutation.isPending}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50" title="Save">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setEditing(null)}
                            className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={row.id}
                    onClick={() => setEditing({ id: row.id, name: row.name, code: row.code ?? '', color: row.color ?? '' })}
                    className="text-[13px] hover:bg-slate-50 border-t border-slate-100 transition-colors cursor-pointer">
                    <td className="px-5 py-3">
                      {resolveColor(row.color) ? (
                        <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: resolveColor(row.color) }} />
                      ) : (
                        <span className="inline-block h-3 w-3 rounded-full bg-slate-200" />
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {row.code ? (
                        <span className="rounded-[5px] bg-slate-50 text-slate-600 text-[11px] font-bold tracking-wide px-2 py-0.5">{row.code}</span>
                      ) : (
                        <span className="text-slate-300">--</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-700">{row.name}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${row.name}"?`)) deleteMutation.mutate(row.id); }}
                        className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] hover:bg-red-50 text-slate-300 hover:text-red-600 transition-colors" title={`Delete ${row.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
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
              {rows.length} {rows.length === 1 ? 'service' : 'services'}
              {search && ' matching'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
