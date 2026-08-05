import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers, ChevronRight, ChevronDown, CheckSquare } from 'lucide-react';
import client from '@/api/client';
import { ServiceGroupItem } from './service-group-item';

// ---------------------------------------------------------------------------
// Read-Only Zone Node (for displaying referenced template content)
// ---------------------------------------------------------------------------

export function ReadOnlyZoneNode({ zone, depth, servicePhaseMap }: { zone: any; depth: number; servicePhaseMap?: Map<string, { name: string; code?: string | null }> }) {
  const [expanded, setExpanded] = useState(false);

  // If this zone references another template, fetch its content
  const refId = zone.referencedTemplateId ?? zone.referencedTemplate?.id;
  const { data: refDetail } = useQuery({
    queryKey: ['templates', refId],
    enabled: !!refId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get(`/templates/${refId}`).then((r) => r.data.data ?? r.data),
  });

  const refTasks: any[] = refDetail?.templateTasks ?? [];
  const refZones: any[] = refDetail?.templateZones ?? [];
  const children: any[] = zone.children ?? [];

  // Group tasks by service tag
  const serviceGroups = new Map<string, any[]>();
  const ungroupedTasks: any[] = [];
  for (const task of refTasks) {
    const match = task.description?.match(/^\[SERVICE:(.+)\]$/);
    if (match) {
      const svcName = match[1];
      if (!serviceGroups.has(svcName)) serviceGroups.set(svcName, []);
      serviceGroups.get(svcName)!.push(task);
    } else {
      ungroupedTasks.push(task);
    }
  }

  const hasContent = refTasks.length > 0 || refZones.length > 0 || children.length > 0;

  return (
    <div style={{ marginLeft: depth > 0 ? 20 : 0 }}>
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-muted/20 cursor-pointer hover:bg-muted/40"
        onClick={() => setExpanded(!expanded)}
      >
        {hasContent ? (
          expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />
        ) : <span className="w-3" />}
        <Layers className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="text-sm text-muted-foreground">{zone.name}</span>
        {zone.code && <span className="text-xs text-muted-foreground">({zone.code})</span>}
        {refId && <span className="text-[10px] text-muted-foreground/60 italic">view-only</span>}
      </div>

      {expanded && hasContent && (
        <div className="ml-5 border-l border-muted pl-3 space-y-0.5 mb-1">
          {/* Services */}
          {Array.from(serviceGroups.entries()).map(([svcName, svcTasks]) => (
            <ServiceGroupItem key={`ro-svc-${svcName}`} serviceName={svcName} tasks={svcTasks} templateId={0} servicePhase={servicePhaseMap?.get(svcName) || null} onDeleteAll={() => {}} readOnly />
          ))}

          {/* Tasks */}
          {ungroupedTasks.map((task: any) => (
            <div key={`ro-task-${task.id}`} className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
              <CheckSquare className="h-3 w-3 shrink-0 text-green-400" />
              <span className="font-mono text-xs w-16">{task.code || '-'}</span>
              <span className="text-xs">{task.name}</span>
              {task.defaultBudgetHours != null && <span className="text-xs">{Number(task.defaultBudgetHours)}h</span>}
            </div>
          ))}

          {/* Referenced template's zones */}
          {refZones.map((rz: any) => (
            <ReadOnlyZoneNode key={`ro-zone-${rz.id}`} zone={rz} depth={depth + 1} servicePhaseMap={servicePhaseMap} />
          ))}

          {/* Direct children */}
          {children.map((child: any) => (
            <ReadOnlyZoneNode key={`ro-child-${child.id}`} zone={child} depth={depth + 1} servicePhaseMap={servicePhaseMap} />
          ))}
        </div>
      )}
    </div>
  );
}
