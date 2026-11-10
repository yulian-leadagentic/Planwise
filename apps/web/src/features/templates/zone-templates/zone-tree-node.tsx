import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Layers, ChevronRight, ChevronDown, Link, CheckSquare } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { InstanceCountStepper } from './instance-count-stepper';
import { ZoneTemplatePicker } from './zone-template-picker';
import { ServiceGroupItem } from './service-group-item';
import { ReadOnlyZoneNode } from './read-only-zone-node';
import { ManualZoneForm } from './manual-zone-form';
import { ZONE_DISPLAY } from './constants';
import { useZoneTypeOptions } from '@/hooks/use-zone-type-options';

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
  // QA3 Wave-2 Commit 5 (PR-032): sibling to `showAddChild`. The
  // existing picker only references other zone templates; this opens
  // a compact manual form with a zoneType picker so children can be
  // tagged Site / Building / Level without a round-trip.
  const [showAddChildManual, setShowAddChildManual] = useState(false);
  // Tracks the in-flight "delete this zone" confirmation so the styled
  // ConfirmDialog can replace the native confirm() popup.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ZT-5 · zoneType dropdown sourced from the admin-managed
  // `/admin/config/zone-types` catalog (replacing the previously
  // hardcoded `ZONE_TYPES` list). Pass the zone's current zoneType so
  // a legacy code admin has removed from the catalog still renders
  // as a selectable option.
  const { options: zoneTypeOptions } = useZoneTypeOptions(zone.zoneType);

  const children: any[] = zone.children ?? [];

  // P1 · Reference model (2026-11-10) — "Linked" deliverable slot
  // detection. A zone with `linkedTaskTemplateId` is a reference-slot
  // for a deliverable template, not a hand-built zone. The findOne
  // include now pulls the linked deliverable's `templateTasks` +
  // their `predecessors`, so we render both as a read-only nested
  // list — editing lives in the source deliverable, and changes to
  // predecessors in that deliverable immediately reflect here.
  const linkedDeliverable: any = zone.linkedTaskTemplate ?? null;
  const linkedTasks: any[] = linkedDeliverable?.templateTasks ?? [];
  const hasLinkedContent = !!linkedDeliverable;

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

  // Group referenced tasks by service tag. QA4 B1 follow-up (2026-09-29) —
  // prefer the live `deliverableTemplate.name` from the FK relation the
  // API now includes; fall back to the legacy `[SERVICE:<name>]` marker
  // only when the FK is missing.
  const refServiceGroups = new Map<string, any[]>();
  const refUngroupedTasks: any[] = [];
  for (const task of refTasks) {
    const svcName = task.deliverableTemplate?.name
      ?? task.description?.match(/^\[SERVICE:(.+)\]$/)?.[1];
    if (svcName) {
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
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex h-6 w-6 min-w-[24px] min-h-[24px] shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${zone.name}`}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
        </button>
        {/* Inline zoneType editor. Was a display-only ZoneTypeBadge —
            now writable so template authors can retag Zone → Building
            → Level without re-creating rows. PATCH goes through the
            existing `updateMutation` (which already handles other
            fields on the same zone). The `<select>` renders the
            current color chip via `ZONE_DISPLAY`, matching the badge
            look. Read-only view (ReadOnlyZoneNode) still uses the
            plain badge. */}
        <label className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-2 pr-1 py-0.5 text-[11px] font-semibold cursor-pointer" title="Change zone type">
          <span
            className="h-2 w-2 rounded-full border border-slate-200 dark:border-slate-700"
            style={{ backgroundColor: ZONE_DISPLAY[zone.zoneType]?.color ?? '#6B7280' }}
          />
          <select
            value={zone.zoneType}
            onChange={(e) => updateMutation.mutate({ zoneType: e.target.value })}
            disabled={updateMutation.isPending}
            className="bg-transparent border-none outline-none text-[11px] font-semibold text-slate-700 dark:text-slate-200 pr-1 cursor-pointer"
            aria-label={`Zone type — currently ${ZONE_DISPLAY[zone.zoneType]?.label ?? zone.zoneType}`}
          >
            {zoneTypeOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm font-semibold truncate min-w-0">{zone.name}</span>
        {zone.code && <span className="text-xs text-muted-foreground">({zone.code})</span>}
        {(zone.referencedTemplate || refTemplateId) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            <Link className="h-3 w-3" /> ref: {zone.referencedTemplate?.name || refTemplateDetail?.name || `#${refTemplateId}`}
          </span>
        )}
        {/* P1 · Deliverable-slot header chrome (2026-11-10). A single
            compact "Linked" badge + the referenced deliverable's
            name/code reads the same way a chip on the Deliverable
            Templates list row does — blue entity color, mono code,
            no shadow. `title` carries the "edit in the source
            deliverable" guidance so the editor's tasks beneath can
            stay un-annotated (less visual noise per row). */}
        {linkedDeliverable && (
          <>
            <span
              className="inline-flex items-center gap-1 rounded-[5px] bg-blue-50 px-2 py-0.5 text-[11px] font-bold tracking-wide text-blue-600"
              title="Deliverable reference. Edit the tasks in the source deliverable template."
            >
              <Link className="h-3 w-3" aria-hidden="true" /> Linked
            </span>
            <span className="text-[13px] text-slate-700">{linkedDeliverable.name}</span>
            {linkedDeliverable.code && (
              <span className="font-mono text-xs font-medium text-slate-500">
                {linkedDeliverable.code}
              </span>
            )}
          </>
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

        {/* Add-child affordances — labels mirror the root menu so the
            same distinction ("choose type" vs "copy from template")
            reads the same at every depth. */}
        <button
          onClick={() => { setShowAddChildManual(true); setExpanded(true); }}
          className="ml-auto shrink-0 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          title="Create a child zone and choose its type"
        >
          <Plus className="h-3 w-3" /> Add Zone (choose type)
        </button>
        <button
          onClick={() => { setShowAddChild(true); setExpanded(true); }}
          className="shrink-0 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          title="Copy a child zone from an existing template — its type is carried over"
        >
          <Plus className="h-3 w-3" /> Copy from Template
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
          {/* P1 · Reference model (2026-11-10) — read-only linked
              deliverable tasks + their predecessors. Renders the
              deliverable's own task graph as a flat list under the
              slot so DoD is observable: editing predecessors in the
              source deliverable reflects here on the next load.
              Tasks are NOT editable in this view — the edit surface
              lives in the Deliverable Template editor (link via
              `/templates/deliverables/<id>` is intentionally left
              for the FE routing follow-up; the badge + tooltip
              above already names where to go). */}
          {hasLinkedContent && linkedTasks.length > 0 && (
            <>
              {linkedTasks.map((task: any) => {
                // Build a compact "← PRED-001 (3wd), PRED-002 (0wd)"
                // summary. `wd` = working days, `cal` = calendar days,
                // matching the Deliverable Template editor's own
                // predecessor chip language. Tasks with no
                // predecessors render without the arrow block so the
                // row stays scannable.
                const preds: any[] = task.predecessors ?? [];
                const predSummary = preds
                  .map((p: any) => {
                    const code =
                      p.dependsOnTemplateTask?.code ??
                      `#${p.dependsOnTemplateTaskId}`;
                    const lagN = Number(p.lag ?? 0);
                    const unit =
                      p.lagUnit === 'CALENDAR_DAYS' ? 'cal' : 'wd';
                    return lagN > 0 ? `${code} (${lagN}${unit})` : code;
                  })
                  .join(', ');
                return (
                  <div
                    key={`linked-task-${task.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-slate-50/60"
                    title="Read-only — edit in the source deliverable template"
                  >
                    <CheckSquare
                      className="h-3.5 w-3.5 shrink-0 text-green-400"
                      aria-hidden="true"
                    />
                    <span className="font-mono text-xs font-medium text-slate-500 w-20 truncate">
                      {task.code || '-'}
                    </span>
                    <span className="text-[13px] text-slate-700 truncate">
                      {task.name}
                    </span>
                    {task.defaultBudgetHours != null && (
                      <span className="font-mono text-xs font-medium text-slate-400">
                        {Number(task.defaultBudgetHours)}h
                      </span>
                    )}
                    {predSummary && (
                      <span
                        className="ml-auto font-mono text-[11px] text-slate-500"
                        title={`Predecessors: ${predSummary}`}
                      >
                        {'←'} {predSummary}
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          )}
          {hasLinkedContent && linkedTasks.length === 0 && (
            <p className="py-2 text-[11px] font-medium italic text-slate-400">
              Linked deliverable has no tasks yet.
            </p>
          )}

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

          {showAddChildManual && (
            <div className="mt-1">
              <ManualZoneForm templateId={templateId} parentId={zone.id} onDone={() => setShowAddChildManual(false)} />
            </div>
          )}

          {showAddChild && (
            <div className="mt-1">
              <ZoneTemplatePicker templateId={templateId} parentId={zone.id} onDone={() => setShowAddChild(false)} />
            </div>
          )}

          {children.length === 0 && !hasRefContent && !hasLinkedContent && !showAddChild && (
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
