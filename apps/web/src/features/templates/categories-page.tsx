import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

export function CategoriesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['service-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/service-types').then((r) => r.data.data ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string; color?: string }) =>
      client.post('/service-types', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types'] });
      toast.success('Service type created');
      setShowForm(false);
      setName('');
      setCode('');
      setColor('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/service-types/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types'] });
      toast.success('Service type deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      code: code.trim() || undefined,
      color: color.trim() || undefined,
    });
  };

  const serviceTypes = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Service Types"
          description="Types like BIM, MEP, Structural, Architecture"
          actions={
            <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              <Plus className="h-4 w-4" /> Add Service Type
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Service Type Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BIM, MEP, Structural" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. BIM, MEP" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Color</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">#</span>
                <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="e.g. 3B82F6" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={2} />
      ) : serviceTypes.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No service types yet. Click "Add Service Type" to create one.</p>
      ) : (
        <div className="rounded-lg border border-border">
          {serviceTypes.map((c: any, i: number) => (
            <div key={c.id} className={`flex items-center justify-between px-4 py-3 ${i < serviceTypes.length - 1 ? 'border-b border-border' : ''} hover:bg-muted/30`}>
              <div className="flex items-center gap-2">
                {c.color && (
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: c.color.startsWith('#') ? c.color : `#${c.color}` }} />
                )}
                <span className="text-sm font-medium">{c.name}</span>
                {c.code && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{c.code}</span>}
              </div>
              <button onClick={() => { if (confirm(`Delete "${c.name}"?`)) deleteMutation.mutate(c.id); }} className="text-xs text-red-600 hover:underline">Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
