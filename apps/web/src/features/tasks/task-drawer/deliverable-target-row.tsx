import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';

/**
 * Deliverable target date, read from the parent project's deliverable
 * list (via /project-deliverables?projectId=X). Prefers the
 * (zone × deliverable) target when the task has a zoneId; otherwise
 * falls back to the deliverable-level target. Renders nothing if the
 * task isn't linked to a Deliverable at all. (Tier E #10, 2026-08-02.)
 */
export function DeliverableTargetRow({ task }: { task: any }) {
  const projectId = task?.projectId;
  const deliverableId = task?.projectDeliverableId;
  const { data: deliverables } = useQuery<any[]>({
    queryKey: ['project-deliverables', projectId],
    enabled: !!projectId && !!deliverableId,
    queryFn: () =>
      client
        .get('/project-deliverables', { params: { projectId } })
        .then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : [];
        }),
    staleTime: 30 * 1000,
  });

  if (!deliverableId) return null;
  const d = deliverables?.find((x) => x.id === deliverableId);
  if (!d) return null;
  const zoneTarget = task.zoneId != null ? d.zoneTargets?.find((zt: any) => zt.zoneId === task.zoneId) : null;
  const targetDate = zoneTarget?.targetDate ?? d.targetDate ?? null;
  const dateStr = targetDate ? String(targetDate).slice(0, 10) : null;

  return (
    <div className="flex items-center gap-2">
      <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-20 shrink-0">Deliverable</label>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-700 dark:text-slate-200 font-medium">{d.name}</span>
        {dateStr ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 tabular-nums" title={zoneTarget ? `Zone × Deliverable target` : 'Deliverable-level target'}>
            {dateStr}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500 italic text-[12px]">no target set</span>
        )}
      </div>
    </div>
  );
}
