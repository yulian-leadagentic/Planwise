import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Layers, ChevronRight, ChevronDown, Link, CheckSquare } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { ZoneTypeBadge } from './zone-type-badge';
import { InstanceCountStepper } from './instance-count-stepper';
import { ZoneTemplatePicker } from './zone-template-picker';
import { ServiceGroupItem } from './service-group-item';
import { ReadOnlyZoneNode } from './read-only-zone-node';

// ---------------------------------------------------------------------------
// Zone Tree Node (recursive)
// ---------------------------------------------------------------------------

export function ZoneTreeNode({
  zone,
  templateId,
  taskTemplates,
  phases,
  depth,
  servicePhaseMap,
}: {
  zone: any;
  templateId: number;
  taskTemplates: any[];
  phases: any[];
  depth: number;
  servicePhaseMap?: Map<string, { name: string; code?: string | null }>;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(true);
  const [showAddChild, setShowAddChild] = useState(false);
  // Tracks the in-flight "delete this zone" confirmation so the styled
  // ConfirmDialog can replace the native confirm() popup.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const children: any[] = zone.children ?? [];

  // Fetch referenced template content if this zone references another template
  const refTemplateId = zone.referencedTemplateId ?? zone.referencedTemplate?.id;
  const { data: refTemplateDetail, isLoading: refLoading } = useQuery({
    queryKey: ['templates', refTemplateId],
    enabled: !!refTemplateId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get(`/templates/${refTemplateId}`).then((r) => r.data.data ?? r.data),
  });

  // Extract content from referenced template
  const refTasks: any[] = refTemplateDetail?.templateTasks ?? [];
  const refZones: any[] = refTemplateDetail?.templateZones ?? [];

  // Group referenced tasks by service tag
  const refServiceGroups = new Map<string, any[]>();
  const refUngroupedTasks: any[] = [];
  for (const task of refTasks) {
    const match = task.description?.match(/^\[SERVICE:(.+)\]$/);
    if (match) {
      const svcName = match[1];
      if (!refServiceGroups.has(svcName)) refServiceGroups.set(svcName, []);
      refServiceGroups.get(svcName)!.push(task);
    } else {
      refUngroupedTasks.push(task);
    }
  }

  const hasRefContent = refTasks.length > 0 || refZones.length > 0;

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/templates/zone-tasks/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Task removed', { code: 'TASK-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove task'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => client.delete(`/templates/zones/${zone.id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success('Zone deleted', { code: 'ZONE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      client.patch(`/templates/zones/${zone.id}`, data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      notify.success('Zone updated', { code: 'ZONE-UPDATE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update zone'),
  });

  const handleLinkChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    updateMutation.mutate({ linkedTaskTemplateId: val ? Number(val) : null });
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 24 : 0 }}>
      {/* Zone header row. `flex-wrap` keeps the delete + Add Zone buttons
          visible at deeper nesting / narrow widths instead of letting them
          get clipped off-screen; trailing buttons are `shrink-0` so they
          never collapse to zero width. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 mb-1">
        <button onClick={() => setExpanded(!expanded)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <ZoneTypeBadge zoneType={zone.zoneType} />
        <span className="text-sm font-semibold truncate min-w-0">{zone.name}</span>
        {zone.code && <span className="text-xs text-muted-foreground">({zone.code})</span>}
        {(zone.referencedTemplate || refTemplateId) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            <Link className="h-3 w-3" /> ref: {zone.referencedTemplate?.name || refTemplateDetail?.name || `#${refTemplateId}`}
          </span>
        )}
        {zone.isTypical && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            Typical{zone.typicalCount ? ` x${zone.typicalCount}` : ''}
          </span>
        )}

        {/* Instance count — composition multiplicity. When > 1, the apply
            flow instantiates this template-zone N times (each renameable in
            the project planning view). Click to edit. */}
        <InstanceCountStepper
          value={zone.instanceCount ?? 1}
          onChange={(n) => updateMutation.mutate({ instanceCount: n })}
        />

        {/* [+ Add Zone] button — sub-zones only contain other zones. */}
        <button
          onClick={() => { setShowAddChild(true); setExpanded(true); }}
          className="ml-auto shrink-0 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          title="Add child zone"
        >
          <Plus className="h-3 w-3" /> Add Zone
        </button>

        {/* Delete this zone. `shrink-0` keeps it visible even when the row
            is crowded by deeper-nested sub-zones (previously it could get
            squeezed off the right edge on narrow viewports). Visible "Delete"
            label + red outline so the action is unmissable — the bare icon
            was easy to overlook. */}
        <button
          onClick={() => setConfirmingDelete(true)}
          className="shrink-0 flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 hover:border-red-300"
          title="Delete zone"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => { deleteMutation.mutate(undefined, { onSettled: () => setConfirmingDelete(false) }); }}
        variant="danger"
        title="Delete zone?"
        description={`Delete "${zone.name}" and all of its child zones and tasks? This cannot be undone.`}
        confirmLabel="Delete"
        isLoading={deleteMutation.isPending}
      />

      {/* Expanded: referenced content (view-only) + child zones */}
      {expanded && (
        <div className="ml-6 border-l-2 border-border pl-3 space-y-0.5 mb-2">
          {/* View-only: services from referenced template */}
          {Array.from(refServiceGroups.entries()).map(([svcName, svcTasks]) => (
            <ServiceGroupItem key={`ref-svc-${svcName}`} serviceName={svcName} tasks={svcTasks} templateId={templateId} servicePhase={servicePhaseMap?.get(svcName) || null} onDeleteAll={() => {}} readOnly />
          ))}

          {/* View-only: ungrouped tasks from referenced template */}
          {refUngroupedTasks.map((task: any) => (
            <div key={`ref-task-${task.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-muted/20">
              <CheckSquare className="h-3.5 w-3.5 shrink-0 text-green-400" />
              <span className="font-mono text-xs text-muted-foreground w-16">{task.code || '-'}</span>
              <span className="text-sm text-muted-foreground">{task.name}</span>
              {task.defaultBudgetHours != null && <span className="text-xs text-muted-foreground">{Number(task.defaultBudgetHours)}h</span>}
              {task.defaultBudgetAmount != null && <span className="text-xs text-muted-foreground">{'\u20AA'}{Number(task.defaultBudgetAmount).toLocaleString()}</span>}
            </div>
          ))}

          {/* View-only: zones from referenced template (recursive, show their content) */}
          {refZones.map((rz: any) => (
            <ReadOnlyZoneNode key={`ref-zone-${rz.id}`} zone={rz} depth={0} servicePhaseMap={servicePhaseMap} />
          ))}

          {/* Editable: child zones in this template */}
          {children.map((child: any) => (
            <ZoneTreeNode
              key={child.id}
              zone={child}
              templateId={templateId}
              taskTemplates={taskTemplates}
              phases={phases}
              depth={depth + 1}
              servicePhaseMap={servicePhaseMap}
            />
          ))}

          {showAddChild && (
            <div className="mt-1">
              <ZoneTemplatePicker templateId={templateId} parentId={zone.id} onDone={() => setShowAddChild(false)} />
            </div>
          )}

          {children.length === 0 && !hasRefContent && !showAddChild && (
            refTemplateId && refLoading
              ? <p className="py-2 text-xs text-muted-foreground italic">Loading zone content...</p>
              : !refTemplateId
                ? <p className="py-2 text-xs text-muted-foreground italic">Empty zone. Click [+ Add Zone] to add child zones.</p>
                : <p className="py-2 text-xs text-muted-foreground italic">Referenced zone has no content.</p>
          )}
        </div>
      )}

    </div>
  );
}
