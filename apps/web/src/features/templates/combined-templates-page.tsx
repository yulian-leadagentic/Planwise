import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Trash2, Grid3x3, ChevronRight, ChevronDown, Link2 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const btnSecondary = 'rounded-md border border-border px-4 py-2 text-sm hover:bg-accent';

const ZONE_DISPLAY: Record<string, { color: string; label: string }> = {
  site: { color: '#6B7280', label: 'Site' },
  building: { color: '#3B82F6', label: 'Building' },
  level: { color: '#10B981', label: 'Level' },
  zone: { color: '#F59E0B', label: 'Zone' },
  area: { color: '#8B5CF6', label: 'Area' },
  section: { color: '#14B8A6', label: 'Section' },
  wing: { color: '#EC4899', label: 'Wing' },
  floor: { color: '#6B7280', label: 'Floor' },
};

const ZONE_TYPE_OPTIONS = Object.keys(ZONE_DISPLAY);

// ---------------------------------------------------------------------------
// Helper: build tree from flat zones list
// ---------------------------------------------------------------------------

interface TemplateZone {
  id: number;
  name: string;
  zoneType: string;
  parentId: number | null;
  sortOrder?: number;
  linkedTaskTemplateId?: number | null;
  linkedTaskTemplate?: { id: number; name: string } | null;
  children?: TemplateZone[];
}

function buildTree(zones: TemplateZone[]): TemplateZone[] {
  const map = new Map<number, TemplateZone>();
  const roots: TemplateZone[] = [];

  for (const z of zones) {
    map.set(z.id, { ...z, children: [] });
  }
  for (const z of zones) {
    const node = map.get(z.id)!;
    if (z.parentId && map.has(z.parentId)) {
      map.get(z.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  const sort = (arr: TemplateZone[]) => {
    arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const n of arr) if (n.children?.length) sort(n.children);
  };
  sort(roots);
  return roots;
}

function countZonesFlat(zones: TemplateZone[]): number {
  return zones.length;
}

// ---------------------------------------------------------------------------
// Zone Node Component
// ---------------------------------------------------------------------------

function ZoneNode({
  zone,
  depth,
  taskTemplates,
  onAddChild,
  onDelete,
  onUpdate,
}: {
  zone: TemplateZone;
  depth: number;
  taskTemplates: any[];
  onAddChild: (parentId: number) => void;
  onDelete: (zoneId: number, zoneName: string) => void;
  onUpdate: (zoneId: number, data: Record<string, any>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(zone.name);
  const [editZoneType, setEditZoneType] = useState(zone.zoneType);
  const [editLinkedTemplateId, setEditLinkedTemplateId] = useState<string>(
    zone.linkedTaskTemplateId ? String(zone.linkedTaskTemplateId) : ''
  );

  const hasChildren = (zone.children?.length ?? 0) > 0;
  const display = ZONE_DISPLAY[zone.zoneType] ?? { color: '#6B7280', label: zone.zoneType };

  const handleSaveEdit = () => {
    if (!editName.trim()) return;
    onUpdate(zone.id, {
      name: editName.trim(),
      zoneType: editZoneType,
      linkedTaskTemplateId: editLinkedTemplateId ? Number(editLinkedTemplateId) : null,
    });
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditName(zone.name);
    setEditZoneType(zone.zoneType);
    setEditLinkedTemplateId(zone.linkedTaskTemplateId ? String(zone.linkedTaskTemplateId) : '');
    setEditing(false);
  };

  const linkedTemplateName = zone.linkedTaskTemplate?.name
    ?? taskTemplates.find((t: any) => t.id === zone.linkedTaskTemplateId)?.name;

  return (
    <div>
      <div
        className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-muted/50"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {/* Zone type badge */}
        <span
          className="inline-block rounded px-1.5 py-0.5 text-xs font-medium text-white"
          style={{ backgroundColor: display.color }}
        >
          {display.label}
        </span>

        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={`${inputClass} !w-40`}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveEdit();
                if (e.key === 'Escape') handleCancelEdit();
              }}
            />
            <select
              value={editZoneType}
              onChange={(e) => setEditZoneType(e.target.value)}
              className={`${inputClass} !w-28`}
            >
              {ZONE_TYPE_OPTIONS.map((zt) => (
                <option key={zt} value={zt}>{ZONE_DISPLAY[zt].label}</option>
              ))}
            </select>
            <select
              value={editLinkedTemplateId}
              onChange={(e) => setEditLinkedTemplateId(e.target.value)}
              className={`${inputClass} !w-48`}
            >
              <option value="">-- no service template --</option>
              {taskTemplates.map((t: any) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button onClick={handleSaveEdit} className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700">
              Save
            </button>
            <button onClick={handleCancelEdit} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent">
              Cancel
            </button>
          </div>
        ) : (
          <>
            {/* Zone name */}
            <span
              className="cursor-pointer text-sm font-medium hover:underline"
              onClick={() => setEditing(true)}
            >
              {zone.name}
            </span>

            {/* Linked service template indicator */}
            {(zone.linkedTaskTemplateId || linkedTemplateName) && (
              <span className="ml-1 flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                <Link2 className="h-3 w-3" />
                {linkedTemplateName ?? `Template #${zone.linkedTaskTemplateId}`}
              </span>
            )}

            {/* Actions (visible on hover) */}
            <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={() => onAddChild(zone.id)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Add child zone"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onDelete(zone.id, zone.name)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-red-100 hover:text-red-600"
                title="Delete zone"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {zone.children!.map((child) => (
            <ZoneNode
              key={child.id}
              zone={child}
              depth={depth + 1}
              taskTemplates={taskTemplates}
              onAddChild={onAddChild}
              onDelete={onDelete}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor View
// ---------------------------------------------------------------------------

function EditorView({
  templateId,
  onBack,
}: {
  templateId: number;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();

  // ---- fetch template detail ----
  const { data: template, isLoading } = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => client.get(`/templates/${templateId}`).then((r) => r.data.data ?? r.data),
  });

  // ---- fetch task_list templates for linking ----
  const { data: taskTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });

  // ---- header editing ----
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerForm, setHeaderForm] = useState({ name: '', code: '', category: '', description: '' });

  const updateTemplateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/${templateId}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Template updated');
      setEditingHeader(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to update template'),
  });

  // ---- add zone form ----
  const [addingZoneParentId, setAddingZoneParentId] = useState<number | null | 'root'>(null);
  const [newZone, setNewZone] = useState({ name: '', zoneType: 'zone', linkedTaskTemplateId: '' });

  const addZoneMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.post(`/templates/${templateId}/zones`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Zone added');
      setNewZone({ name: '', zoneType: 'zone', linkedTaskTemplateId: '' });
      setAddingZoneParentId(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to add zone'),
  });

  const updateZoneMutation = useMutation({
    mutationFn: ({ zoneId, data }: { zoneId: number; data: Record<string, any> }) =>
      client.patch(`/templates/zones/${zoneId}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Zone updated');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to update zone'),
  });

  const deleteZoneMutation = useMutation({
    mutationFn: (zoneId: number) =>
      client.delete(`/templates/zones/${zoneId}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Zone deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete zone'),
  });

  // ---- handlers ----
  const handleAddZone = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newZone.name.trim()) return;
    addZoneMutation.mutate({
      name: newZone.name.trim(),
      zoneType: newZone.zoneType,
      parentId: addingZoneParentId === 'root' ? undefined : addingZoneParentId,
      linkedTaskTemplateId: newZone.linkedTaskTemplateId ? Number(newZone.linkedTaskTemplateId) : undefined,
    });
  };

  const handleAddChild = useCallback((parentId: number) => {
    setAddingZoneParentId(parentId);
    setNewZone({ name: '', zoneType: 'zone', linkedTaskTemplateId: '' });
  }, []);

  const handleDeleteZone = useCallback((zoneId: number, zoneName: string) => {
    if (confirm(`Delete zone "${zoneName}" and all its children?`)) {
      deleteZoneMutation.mutate(zoneId);
    }
  }, [deleteZoneMutation]);

  const handleUpdateZone = useCallback((zoneId: number, data: Record<string, any>) => {
    updateZoneMutation.mutate({ zoneId, data });
  }, [updateZoneMutation]);

  const handleSaveHeader = (e: React.FormEvent) => {
    e.preventDefault();
    if (!headerForm.name.trim()) return;
    updateTemplateMutation.mutate({
      name: headerForm.name.trim(),
      code: headerForm.code.trim() || undefined,
      category: headerForm.category.trim() || undefined,
      description: headerForm.description.trim() || undefined,
    });
  };

  const startEditingHeader = () => {
    if (!template) return;
    setHeaderForm({
      name: template.name ?? '',
      code: template.code ?? '',
      category: template.category ?? '',
      description: template.description ?? '',
    });
    setEditingHeader(true);
  };

  if (isLoading) return <TableSkeleton rows={5} cols={4} />;
  if (!template) return <div className="p-8 text-center text-muted-foreground">Template not found.</div>;

  const zones: TemplateZone[] = template.templateZones ?? [];
  const tree = buildTree(zones);

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to templates
      </button>

      {/* Template header */}
      {editingHeader ? (
        <form onSubmit={handleSaveHeader} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input value={headerForm.name} onChange={(e) => setHeaderForm((p) => ({ ...p, name: e.target.value }))} className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={headerForm.code} onChange={(e) => setHeaderForm((p) => ({ ...p, code: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              <input value={headerForm.category} onChange={(e) => setHeaderForm((p) => ({ ...p, category: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input value={headerForm.description} onChange={(e) => setHeaderForm((p) => ({ ...p, description: e.target.value }))} className={inputClass} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={updateTemplateMutation.isPending} className={btnPrimary}>
              {updateTemplateMutation.isPending ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditingHeader(false)} className={btnSecondary}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Grid3x3 className="h-5 w-5 text-purple-600" />
                <h2 className="text-lg font-semibold">{template.name}</h2>
                {template.code && <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">{template.code}</span>}
                {template.category && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{template.category}</span>}
              </div>
              {template.description && <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {zones.length} zone{zones.length !== 1 ? 's' : ''} &middot; Used {template.usageCount ?? 0} time{(template.usageCount ?? 0) !== 1 ? 's' : ''}
              </p>
            </div>
            <button onClick={startEditingHeader} className={btnSecondary}>Edit</button>
          </div>
        </div>
      )}

      {/* Zone tree */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Zone Structure</h3>
          <button
            onClick={() => {
              setAddingZoneParentId('root');
              setNewZone({ name: '', zoneType: 'site', linkedTaskTemplateId: '' });
            }}
            className={btnPrimary}
          >
            <Plus className="h-4 w-4" /> Add Zone
          </button>
        </div>

        <div className="rounded-lg border border-border bg-background">
          {/* Add zone form */}
          {addingZoneParentId !== null && (
            <form onSubmit={handleAddZone} className="flex items-center gap-2 border-b border-border bg-brand-50/40 px-3 py-2.5">
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {addingZoneParentId === 'root' ? 'New root zone:' : 'New child zone:'}
              </span>
              <input
                value={newZone.name}
                onChange={(e) => setNewZone((p) => ({ ...p, name: e.target.value }))}
                placeholder="Zone name *"
                className={`${inputClass} !w-40`}
                autoFocus
              />
              <select
                value={newZone.zoneType}
                onChange={(e) => setNewZone((p) => ({ ...p, zoneType: e.target.value }))}
                className={`${inputClass} !w-28`}
              >
                {ZONE_TYPE_OPTIONS.map((zt) => (
                  <option key={zt} value={zt}>{ZONE_DISPLAY[zt].label}</option>
                ))}
              </select>
              <select
                value={newZone.linkedTaskTemplateId}
                onChange={(e) => setNewZone((p) => ({ ...p, linkedTaskTemplateId: e.target.value }))}
                className={`${inputClass} !w-48`}
              >
                <option value="">-- no service template --</option>
                {(taskTemplates as any[]).map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button type="submit" disabled={addZoneMutation.isPending} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                {addZoneMutation.isPending ? 'Adding...' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddingZoneParentId(null);
                  setNewZone({ name: '', zoneType: 'zone', linkedTaskTemplateId: '' });
                }}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                Cancel
              </button>
            </form>
          )}

          {/* Tree */}
          {tree.length === 0 && addingZoneParentId === null ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No zones yet. Click "Add Zone" to start building the zone structure.
            </div>
          ) : (
            <div className="py-1">
              {tree.map((zone) => (
                <ZoneNode
                  key={zone.id}
                  zone={zone}
                  depth={0}
                  taskTemplates={taskTemplates as any[]}
                  onAddChild={handleAddChild}
                  onDelete={handleDeleteZone}
                  onUpdate={handleUpdateZone}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function CombinedTemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', 'combined'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=combined').then((r) => r.data.data ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; code?: string; description?: string; category?: string; type: string }) =>
      client.post('/templates', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Combined template created');
      setShowForm(false);
      setName('');
      setCode('');
      setDescription('');
      setCategory('');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', 'combined'] });
      toast.success('Template deleted');
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      code: code.trim() || undefined,
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      type: 'combined',
    });
  };

  // ---- Editor View ----
  if (selectedTemplateId !== null) {
    return <EditorView templateId={selectedTemplateId} onBack={() => setSelectedTemplateId(null)} />;
  }

  // ---- List View ----
  const templateList = (templates ?? []) as any[];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title="Combined Templates"
          description="Zone structures with services pre-assigned"
          actions={
            <button onClick={() => setShowForm(!showForm)} className={btnPrimary}>
              <Plus className="h-4 w-4" /> New Template
            </button>
          }
        />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard Office Block" className={inputClass} autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Code</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CT.SOB.1" className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. BIM, MEP" className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description" className={inputClass} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending} className={btnPrimary}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className={btnSecondary}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton rows={3} cols={4} />
      ) : templateList.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <Grid3x3 className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No combined templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">Create templates that include both zone structures and services together.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Create Template</button>
        </div>
      ) : (
        <div className="space-y-2">
          {templateList.map((t: any) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-border bg-background p-4 hover:bg-muted/30 cursor-pointer"
              onClick={() => setSelectedTemplateId(t.id)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Grid3x3 className="h-4 w-4 flex-shrink-0 text-purple-600" />
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.code && <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">{t.code}</span>}
                  {t.category && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t.category}</span>}
                </div>
                {t.description && <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>}
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{t._count?.templateZones ?? 0} zone{(t._count?.templateZones ?? 0) !== 1 ? 's' : ''}</span>
                  <span>&middot;</span>
                  <span>Used {t.usageCount ?? 0} time{(t.usageCount ?? 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${t.name}"?`)) deleteMutation.mutate(t.id);
                }}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-red-100 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
