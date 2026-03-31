import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Users, Trash2, Layers, Grid3x3, Tag, ListChecks, FolderKanban, Settings } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { toast } from 'sonner';

type Tab = 'service' | 'zone' | 'combined' | 'categories' | 'phases' | 'project-types' | 'team';

export function TemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('service');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/templates').then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; category?: string }) =>
      client.post('/admin/config/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template created');
      setShowForm(false);
      setName('');
      setDescription('');
      setCategory('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create template'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/admin/config/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({ name: name.trim(), description: description.trim() || undefined, category: category.trim() || undefined });
  };

  const templateList = templates ?? [];

  const templateTabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'service', label: 'Service Templates', icon: <Copy className="h-4 w-4" /> },
    { key: 'zone', label: 'Zone Templates', icon: <Layers className="h-4 w-4" /> },
    { key: 'combined', label: 'Combined Templates', icon: <Grid3x3 className="h-4 w-4" /> },
  ];

  const configTabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'categories', label: 'Service Categories', icon: <Tag className="h-4 w-4" /> },
    { key: 'phases', label: 'Service Phases', icon: <ListChecks className="h-4 w-4" /> },
    { key: 'project-types', label: 'Project Types', icon: <FolderKanban className="h-4 w-4" /> },
    { key: 'team', label: 'Team Templates', icon: <Users className="h-4 w-4" /> },
  ];

  const isTemplateTab = activeTab === 'service' || activeTab === 'zone' || activeTab === 'combined';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description="Manage templates, categories, phases, and project types"
        actions={
          isTemplateTab ? (
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" />
              New Template
            </button>
          ) : undefined
        }
      />

      {showForm && isTemplateTab && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. BIM Coordination Standard"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. BIM, Infrastructure"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
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

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {templateTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
        <div className="mx-2 self-stretch border-l border-border" />
        {configTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              if (tab.key === 'categories') {
                navigate('/templates/categories');
              } else if (tab.key === 'phases') {
                navigate('/templates/phases');
              } else if (tab.key === 'project-types') {
                navigate('/templates/project-types');
              } else {
                setActiveTab(tab.key);
              }
            }}
            className={cn(
              'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Template list content for service/zone/combined tabs */}
      {isTemplateTab && (
        <>
          {isLoading ? (
            <TableSkeleton rows={3} cols={4} />
          ) : templateList.length === 0 ? (
            <div className="rounded-lg border border-border bg-background p-8 text-center">
              <Copy className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-medium">No {activeTab} templates</h3>
              <p className="mt-1 text-sm text-muted-foreground">Create a template to quickly scaffold new projects with predefined zones and services.</p>
              <button
                onClick={() => setShowForm(true)}
                className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                Create Template
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {templateList.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-border bg-background p-4 hover:bg-muted/30">
                  <div>
                    <div className="flex items-center gap-2">
                      <Copy className="h-4 w-4 text-brand-600" />
                      <span className="text-sm font-medium">{t.name}</span>
                      {t.category && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t.category}</span>
                      )}
                      {t.code && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">{t.code}</span>
                      )}
                    </div>
                    {t.description && <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Created by {t.creator?.firstName} {t.creator?.lastName} &middot; v{t.version || 1}
                    </p>
                  </div>
                  <button
                    onClick={() => { if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id); }}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'team' && (
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <Users className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No team templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create a team template to quickly assign the same group of people to new projects.</p>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create Template
          </button>
        </div>
      )}
    </div>
  );
}
