import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Users } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

export function TeamTemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const { data: templates, isLoading } = useQuery({
    queryKey: ['team-templates'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=combined').then((r) => {
      const d = r.data.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; type: string }) =>
      client.post('/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      toast.success('Team template created');
      setShowForm(false);
      setName('');
      setDescription('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-templates'] });
      toast.success('Template deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      type: 'combined',
    });
  };

  const templateList = templates ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Team Templates"
          description="Reusable team compositions for projects"
          actions={
            <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              <Plus className="h-4 w-4" /> New Template
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BIM Coordination Team" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description of the team composition" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
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
        <TableSkeleton rows={3} cols={3} />
      ) : templateList.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <Users className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No team templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create templates to save and reuse team compositions across projects.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Create Template</button>
        </div>
      ) : (
        <div className="space-y-2">
          {templateList.map((t: any) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-border bg-background p-4 hover:bg-muted/30">
              <div>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-rose-600" />
                  <span className="text-sm font-medium">{t.name}</span>
                </div>
                {t.description && <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>}
              </div>
              <button onClick={() => { if (confirm(`Delete "${t.name}"?`)) deleteMutation.mutate(t.id); }} className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
