import { useState, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  X,
  ChevronRight,
  ChevronDown,
  Plus,
  MapPin,
  Layers,
  CheckCircle2,
  Circle,
  Clock,
  BarChart3,
  Building2,
  FolderOpen,
  ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn, formatCurrency, formatNumber, getInitials } from '@/lib/utils';
import { formatDate } from '@/lib/date-utils';
import { useProject } from '@/hooks/use-projects';
import { useZoneTree, useCreateZone } from '@/hooks/use-zones';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import {
  useServices,
  useCreateService,
  useAssignments,
  useUpdateAssignment,
  useCreateAssignment,
  useCreateDeliverable,
  usePlanningData,
} from '@/hooks/use-services';
import { useIsMobile, useIsTablet } from '@/hooks/use-media-query';
import { StatusBadge } from '@/components/shared/status-badge';
import type {
  Zone,
  Service,
  Deliverable,
  Assignment,
  PlanningData,
} from '@/types';

// ─── Zone Tree Node ──────────────────────────────────────────────────────────

interface ZoneNodeProps {
  zone: Zone;
  selectedZoneId: number | null;
  onSelect: (zone: Zone | null) => void;
  depth?: number;
}

function ZoneNode({ zone, selectedZoneId, onSelect, depth = 0 }: ZoneNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = zone.children && zone.children.length > 0;

  return (
    <div>
      <button
        onClick={() => onSelect(selectedZoneId === zone.id ? null : zone)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          selectedZoneId === zone.id
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
            : 'text-foreground hover:bg-muted',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="shrink-0 rounded p-0.5 hover:bg-accent"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        <span className="truncate flex-1">{zone.name}</span>

        <span className="flex shrink-0 items-center gap-1">
          {zone.zoneType && (
            <span
              className="rounded px-1 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: `${zone.zoneType.color}20`,
                color: zone.zoneType.color,
              }}
            >
              {zone.zoneType.name}
            </span>
          )}
          {zone.isTypical && zone.typicalCount > 1 && (
            <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              &times;{zone.typicalCount}
            </span>
          )}
        </span>
      </button>

      {hasChildren && expanded && (
        <div>
          {zone.children!.map((child) => (
            <ZoneNode
              key={child.id}
              zone={child}
              selectedZoneId={selectedZoneId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Zone Tree Panel ─────────────────────────────────────────────────────────

interface ZoneTreePanelProps {
  projectId: number;
  zones: Zone[];
  selectedZoneId: number | null;
  onSelectZone: (zone: Zone | null) => void;
}

function ZoneTreePanel({ projectId, zones, selectedZoneId, onSelectZone }: ZoneTreePanelProps) {
  const [addingZone, setAddingZone] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneTypeId, setNewZoneTypeId] = useState<number>(0);
  const createZone = useCreateZone();

  const { data: zoneTypes } = useQuery({
    queryKey: ['admin', 'zone-types'],
    queryFn: () => client.get('/admin/config/zone-types').then((r: any) => r.data.data),
    staleTime: Infinity,
  });

  const handleAddZone = useCallback(() => {
    if (!newZoneName.trim() || !newZoneTypeId) {
      toast.error('Please enter a name and select a zone type');
      return;
    }
    createZone.mutate(
      { projectId, name: newZoneName.trim(), zoneTypeId: newZoneTypeId },
      {
        onSuccess: () => {
          setNewZoneName('');
          setAddingZone(false);
        },
      },
    );
  }, [newZoneName, newZoneTypeId, projectId, createZone]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <h3 className="text-sm font-semibold">Zones</h3>
        <button
          onClick={() => setAddingZone(!addingZone)}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add zone"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {addingZone && (
        <div className="border-b border-border p-2 space-y-1.5">
          <input
            type="text"
            value={newZoneName}
            onChange={(e) => setNewZoneName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddZone();
              if (e.key === 'Escape') setAddingZone(false);
            }}
            placeholder="Zone name..."
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            autoFocus
          />
          <select
            value={newZoneTypeId}
            onChange={(e) => setNewZoneTypeId(Number(e.target.value))}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value={0}>Select zone type...</option>
            {(zoneTypes ?? []).map((zt: any) => (
              <option key={zt.id} value={zt.id}>{zt.name}</option>
            ))}
          </select>
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setAddingZone(false)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleAddZone}
              disabled={createZone.isPending || !newZoneName.trim() || !newZoneTypeId}
              className="rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        <button
          onClick={() => onSelectZone(null)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            selectedZoneId === null
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Layers className="h-3.5 w-3.5 shrink-0" />
          All Zones
        </button>

        {zones.map((zone) => (
          <ZoneNode
            key={zone.id}
            zone={zone}
            selectedZoneId={selectedZoneId}
            onSelect={onSelectZone}
          />
        ))}

        {zones.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            No zones yet. Click + to add one.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Mobile Zone Selector ────────────────────────────────────────────────────

function flattenZones(zones: Zone[], depth = 0): Array<Zone & { _depth: number }> {
  const result: Array<Zone & { _depth: number }> = [];
  for (const zone of zones) {
    result.push({ ...zone, _depth: depth });
    if (zone.children) {
      result.push(...flattenZones(zone.children, depth + 1));
    }
  }
  return result;
}

interface MobileZoneSelectorProps {
  zones: Zone[];
  selectedZoneId: number | null;
  onSelectZone: (zone: Zone | null) => void;
}

function MobileZoneSelector({ zones, selectedZoneId, onSelectZone }: MobileZoneSelectorProps) {
  const flat = useMemo(() => flattenZones(zones), [zones]);
  const selectedZone = flat.find((z) => z.id === selectedZoneId);

  return (
    <div className="border-b border-border px-3 py-2">
      <select
        value={selectedZoneId ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          if (!val) {
            onSelectZone(null);
          } else {
            const zone = flat.find((z) => z.id === Number(val));
            onSelectZone(zone ?? null);
          }
        }}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
      >
        <option value="">All Zones</option>
        {flat.map((z) => (
          <option key={z.id} value={z.id}>
            {'\u00A0'.repeat(z._depth * 2)}
            {z.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Assignment Row ──────────────────────────────────────────────────────────

interface AssignmentRowProps {
  assignment: Assignment;
  projectId: number;
}

function AssignmentRow({ assignment, projectId }: AssignmentRowProps) {
  const updateAssignment = useUpdateAssignment(projectId);

  const toggleStatus = useCallback(() => {
    const nextStatus = assignment.status === 'completed' ? 'not_started' : 'completed';
    const nextPct = nextStatus === 'completed' ? 100 : 0;
    updateAssignment.mutate({
      id: assignment.id,
      status: nextStatus,
      completionPct: nextPct,
    });
  }, [assignment, updateAssignment]);

  const isComplete = assignment.status === 'completed';

  return (
    <div className="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-muted/50">
      <button
        onClick={toggleStatus}
        className={cn(
          'shrink-0 transition-colors',
          isComplete ? 'text-emerald-500' : 'text-muted-foreground hover:text-foreground',
        )}
        title={isComplete ? 'Mark incomplete' : 'Mark complete'}
      >
        {isComplete ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Circle className="h-4 w-4" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', isComplete && 'text-muted-foreground line-through')}>
          {assignment.name}
        </p>
        {assignment.zone && (
          <p className="truncate text-xs text-muted-foreground">
            <MapPin className="mr-0.5 inline h-3 w-3" />
            {assignment.zone.name}
          </p>
        )}
      </div>

      {assignment.budgetHours != null && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          <Clock className="mr-0.5 inline h-3 w-3" />
          {assignment.budgetHours}h
        </span>
      )}

      {assignment.assignees && assignment.assignees.length > 0 && (
        <div className="flex shrink-0 -space-x-1.5">
          {assignment.assignees.slice(0, 3).map((a) => (
            <div
              key={a.id}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-brand-100 text-[10px] font-medium text-brand-700"
              title={a.user ? `${a.user.firstName} ${a.user.lastName}` : undefined}
            >
              {a.user ? getInitials(a.user.firstName, a.user.lastName) : '?'}
            </div>
          ))}
          {assignment.assignees.length > 3 && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground">
              +{assignment.assignees.length - 3}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Deliverable Section ─────────────────────────────────────────────────────

interface DeliverableSectionProps {
  deliverable: Deliverable;
  assignments: Assignment[];
  projectId: number;
}

function DeliverableSection({ deliverable, assignments, projectId }: DeliverableSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const completedCount = assignments.filter((a) => a.status === 'completed').length;
  const totalCount = assignments.length;
  const completionPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-medium">{deliverable.name}</span>

        {deliverable.percentage != null && (
          <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
            {deliverable.percentage}%
          </span>
        )}

        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
            deliverable.scope === 'project'
              ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400'
              : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400',
          )}
        >
          {deliverable.scope.replace('_', ' ')}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {completedCount}/{totalCount}
          </span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                completionPct === 100 ? 'bg-emerald-500' : 'bg-brand-500',
              )}
              style={{ width: `${completionPct}%` }}
            />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="ml-3 border-l border-border pl-2">
          {assignments.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No assignments</p>
          ) : (
            assignments.map((a) => (
              <AssignmentRow key={a.id} assignment={a} projectId={projectId} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Service Section ─────────────────────────────────────────────────────────

interface ServiceSectionProps {
  service: Service;
  assignments: Assignment[];
  projectId: number;
}

function ServiceSection({ service, assignments, projectId }: ServiceSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const deliverables = service.deliverables ?? [];

  const deliverableAssignments = useMemo(() => {
    const map = new Map<number, Assignment[]>();
    for (const d of deliverables) {
      map.set(d.id, assignments.filter((a) => a.deliverableId === d.id));
    }
    return map;
  }, [deliverables, assignments]);

  const totalAssignments = assignments.length;
  const completedAssignments = assignments.filter((a) => a.status === 'completed').length;

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <FolderOpen className="h-4 w-4 shrink-0 text-brand-500" />
        <span className="font-medium">{service.name}</span>
        {service.code && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {service.code}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {completedAssignments}/{totalAssignments} done
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-2 pb-2">
          {deliverables.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No deliverables in this service
            </p>
          ) : (
            deliverables.map((d) => (
              <DeliverableSection
                key={d.id}
                deliverable={d}
                assignments={deliverableAssignments.get(d.id) ?? []}
                projectId={projectId}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Center Panel ────────────────────────────────────────────────────────────

interface CenterPanelProps {
  projectId: number;
  services: Service[];
  assignments: Assignment[];
  selectedZone: Zone | null;
}

function CenterPanel({ projectId, services, assignments, selectedZone }: CenterPanelProps) {
  const [addingService, setAddingService] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [addingDeliverable, setAddingDeliverable] = useState<number | null>(null);
  const [newDeliverableName, setNewDeliverableName] = useState('');

  const createService = useCreateService(projectId);
  const createDeliverable = useCreateDeliverable(projectId);

  const filteredAssignments = useMemo(() => {
    if (!selectedZone) return assignments;
    return assignments.filter((a) => a.zoneId === selectedZone.id);
  }, [assignments, selectedZone]);

  const serviceAssignments = useMemo(() => {
    const map = new Map<number, Assignment[]>();
    for (const s of services) {
      const deliverableIds = new Set((s.deliverables ?? []).map((d) => d.id));
      map.set(
        s.id,
        filteredAssignments.filter((a) => deliverableIds.has(a.deliverableId)),
      );
    }
    return map;
  }, [services, filteredAssignments]);

  const handleAddService = useCallback(() => {
    if (!newServiceName.trim()) return;
    createService.mutate(
      { name: newServiceName.trim() },
      {
        onSuccess: () => {
          setNewServiceName('');
          setAddingService(false);
        },
      },
    );
  }, [newServiceName, createService]);

  const handleAddDeliverable = useCallback(
    (serviceId: number) => {
      if (!newDeliverableName.trim()) return;
      createDeliverable.mutate(
        { serviceId, name: newDeliverableName.trim() },
        {
          onSuccess: () => {
            setNewDeliverableName('');
            setAddingDeliverable(null);
          },
        },
      );
    },
    [newDeliverableName, createDeliverable],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          {selectedZone ? (
            <>
              <MapPin className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold">{selectedZone.name}</h3>
              {selectedZone.areaSqm != null && (
                <span className="text-xs text-muted-foreground">
                  {formatNumber(selectedZone.areaSqm)} m&sup2;
                </span>
              )}
            </>
          ) : (
            <>
              <Layers className="h-4 w-4 text-brand-500" />
              <h3 className="text-sm font-semibold">All Zones</h3>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAddingService(!addingService)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" />
            Service
          </button>
        </div>
      </div>

      {addingService && (
        <div className="border-b border-border p-3">
          <input
            type="text"
            value={newServiceName}
            onChange={(e) => setNewServiceName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddService();
              if (e.key === 'Escape') setAddingService(false);
            }}
            placeholder="Service name..."
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            autoFocus
          />
          <div className="mt-1.5 flex justify-end gap-1">
            <button
              onClick={() => setAddingService(false)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleAddService}
              disabled={createService.isPending || !newServiceName.trim()}
              className="rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {services.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Building2 className="mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">No services yet</p>
            <p className="mt-1 text-xs">Add a service to start planning deliverables</p>
          </div>
        ) : (
          services.map((service) => (
            <div key={service.id}>
              <ServiceSection
                service={service}
                assignments={serviceAssignments.get(service.id) ?? []}
                projectId={projectId}
              />
              {addingDeliverable === service.id ? (
                <div className="ml-4 mt-1 rounded-md border border-border p-2">
                  <input
                    type="text"
                    value={newDeliverableName}
                    onChange={(e) => setNewDeliverableName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddDeliverable(service.id);
                      if (e.key === 'Escape') setAddingDeliverable(null);
                    }}
                    placeholder="Deliverable name..."
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    autoFocus
                  />
                  <div className="mt-1.5 flex justify-end gap-1">
                    <button
                      onClick={() => setAddingDeliverable(null)}
                      className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleAddDeliverable(service.id)}
                      disabled={createDeliverable.isPending || !newDeliverableName.trim()}
                      className="rounded bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setAddingDeliverable(service.id);
                    setNewDeliverableName('');
                  }}
                  className="ml-4 mt-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  Add Deliverable
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Right Panel ─────────────────────────────────────────────────────────────

interface RightPanelProps {
  planningData: PlanningData | undefined;
  isLoading: boolean;
}

function RightPanel({ planningData, isLoading }: RightPanelProps) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (!planningData) return null;

  const { project, budgetSummary, zones = [], assignments = [] } = planningData;
  const totalZones = zones?.length ?? 0;
  const totalAssignments = assignments?.length ?? 0;
  const completedAssignments = assignments?.filter((a: any) => a.status === 'completed').length ?? 0;
  const completionPct =
    totalAssignments > 0 ? Math.round((completedAssignments / totalAssignments) * 100) : 0;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* Budget Summary */}
      <div className="rounded-lg border border-border p-3">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <BarChart3 className="h-3.5 w-3.5" />
          Budget Summary
        </h4>
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Bottom-up</span>
            <span className="text-sm font-medium">{formatCurrency(budgetSummary.bottomUp)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Top-down</span>
            <span className="text-sm font-medium">{formatCurrency(budgetSummary.topDown)}</span>
          </div>
          <div className="border-t border-border pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Variance</span>
              <span
                className={cn(
                  'text-sm font-semibold',
                  budgetSummary.variance > 0
                    ? 'text-red-600'
                    : budgetSummary.variance < 0
                      ? 'text-emerald-600'
                      : 'text-foreground',
                )}
              >
                {budgetSummary.variance > 0 ? '+' : ''}
                {formatCurrency(budgetSummary.variance)}
              </span>
            </div>
            <p
              className={cn(
                'mt-0.5 text-right text-xs',
                budgetSummary.variancePct > 0 ? 'text-red-500' : 'text-emerald-500',
              )}
            >
              {budgetSummary.variancePct > 0 ? '+' : ''}
              {budgetSummary.variancePct.toFixed(1)}%
            </p>
          </div>
        </div>
      </div>

      {/* Project Info */}
      <div className="rounded-lg border border-border p-3">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" />
          Project Info
        </h4>
        <div className="mt-3 space-y-2">
          <div>
            <p className="text-xs text-muted-foreground">Status</p>
            <StatusBadge status={project.status} className="mt-0.5" />
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="rounded-lg border border-border p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Quick Stats
        </h4>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <p className="text-xl font-bold">{totalZones}</p>
            <p className="text-xs text-muted-foreground">Zones</p>
          </div>
          <div>
            <p className="text-xl font-bold">{totalAssignments}</p>
            <p className="text-xs text-muted-foreground">Assignments</p>
          </div>
          <div className="col-span-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Completion</p>
              <p className="text-sm font-semibold">{completionPct}%</p>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  completionPct === 100 ? 'bg-emerald-500' : 'bg-brand-500',
                )}
                style={{ width: `${completionPct}%` }}
              />
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {completedAssignments} of {totalAssignments} complete
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Mobile Bottom Sheet (Right Panel) ───────────────────────────────────────

interface MobileBottomSheetProps {
  planningData: PlanningData | undefined;
  isLoading: boolean;
  open: boolean;
  onClose: () => void;
}

function MobileBottomSheet({ planningData, isLoading, open, onClose }: MobileBottomSheetProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-2xl bg-background shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-background px-4 py-3">
          <h3 className="font-semibold">Project Overview</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        <RightPanel planningData={planningData} isLoading={isLoading} />
      </div>
    </div>
  );
}

// ─── Planning Modal (Main) ───────────────────────────────────────────────────

interface PlanningModalProps {
  projectId: number;
  onClose?: () => void;
  fullScreen?: boolean;
}

export function PlanningModal({ projectId, onClose, fullScreen = false }: PlanningModalProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [showBottomSheet, setShowBottomSheet] = useState(false);

  const { data: project } = useProject(projectId);
  const { data: zones = [] } = useZoneTree(projectId);
  const { data: services = [] } = useServices(projectId);
  const { data: assignmentsData = [] } = useAssignments({ projectId });
  const { data: planningData, isLoading: planningLoading } = usePlanningData(projectId);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      navigate(`/projects/${projectId}`);
    }
  }, [onClose, navigate, projectId]);

  const handleSelectZone = useCallback((zone: Zone | null) => {
    setSelectedZone(zone);
  }, []);

  // Mobile layout
  if (isMobile) {
    return (
      <div className={cn('flex h-full flex-col bg-background', fullScreen && 'fixed inset-0 z-40')}>
        {/* Mobile header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <button onClick={handleClose} className="rounded-md p-1 hover:bg-accent">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{project?.name ?? 'Planning'}</h2>
          </div>
          <button
            onClick={() => setShowBottomSheet(true)}
            className="rounded-md p-1.5 hover:bg-accent"
            title="Project overview"
          >
            <BarChart3 className="h-4 w-4" />
          </button>
        </div>

        <MobileZoneSelector
          zones={zones}
          selectedZoneId={selectedZone?.id ?? null}
          onSelectZone={handleSelectZone}
        />

        <div className="flex-1 overflow-hidden">
          <CenterPanel
            projectId={projectId}
            services={services}
            assignments={assignmentsData}
            selectedZone={selectedZone}
          />
        </div>

        <MobileBottomSheet
          planningData={planningData}
          isLoading={planningLoading}
          open={showBottomSheet}
          onClose={() => setShowBottomSheet(false)}
        />
      </div>
    );
  }

  return (
    <div className={cn('flex h-full bg-background', fullScreen && 'fixed inset-0 z-40')}>
      {/* Left panel - Zone tree */}
      {isTablet ? (
        <div
          className={cn(
            'shrink-0 border-r border-border transition-all',
            leftCollapsed ? 'w-12' : 'w-[250px]',
          )}
        >
          {leftCollapsed ? (
            <div className="flex h-full flex-col items-center pt-2">
              <button
                onClick={() => setLeftCollapsed(false)}
                className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Expand zones"
              >
                <MapPin className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-end px-2 pt-1">
                <button
                  onClick={() => setLeftCollapsed(true)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                  title="Collapse"
                >
                  <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                </button>
              </div>
              <ZoneTreePanel
                projectId={projectId}
                zones={zones}
                selectedZoneId={selectedZone?.id ?? null}
                onSelectZone={handleSelectZone}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="w-[250px] shrink-0 border-r border-border">
          <ZoneTreePanel
            projectId={projectId}
            zones={zones}
            selectedZoneId={selectedZone?.id ?? null}
            onSelectZone={handleSelectZone}
          />
        </div>
      )}

      {/* Center panel - Assignments grouped by service/deliverable */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <CenterPanel
          projectId={projectId}
          services={services}
          assignments={assignmentsData}
          selectedZone={selectedZone}
        />
      </div>

      {/* Right panel - Context */}
      <div className="w-[280px] shrink-0 border-l border-border">
        <RightPanel planningData={planningData} isLoading={planningLoading} />
      </div>

      {/* Header bar (full-screen mode) */}
      {fullScreen && (
        <div className="fixed left-0 right-0 top-0 z-50 flex items-center gap-3 border-b border-border bg-background px-4 py-2 shadow-sm">
          <button onClick={handleClose} className="rounded-md p-1.5 hover:bg-accent">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h2 className="text-base font-semibold">{project?.name ?? 'Planning'}</h2>
          <StatusBadge status={project?.status ?? 'active'} />
          <div className="flex-1" />
          <button onClick={handleClose} className="rounded-md p-1.5 hover:bg-accent" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Planning Page (route wrapper) ───────────────────────────────────────────

export function PlanningPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);

  if (!projectId || isNaN(projectId)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Invalid project ID</p>
      </div>
    );
  }

  return (
    <div className="h-screen pt-[49px]">
      <PlanningModal projectId={projectId} fullScreen />
    </div>
  );
}
