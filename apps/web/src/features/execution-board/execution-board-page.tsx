import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Grid3X3, FolderKanban } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { ProjectSelect } from '@/components/shared/project-select';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';
import client from '@/api/client';

interface Phase {
  id: number;
  name: string;
  code: string | null;
  color: string | null;
}

interface Service {
  id: number;
  name: string;
  code: string | null;
  color: string | null;
}

interface Assignee {
  user: { id: number; firstName: string; lastName: string; avatarUrl: string | null };
}

interface Task {
  id: number;
  code: string;
  name: string;
  status: string;
  completionPct: number;
  zoneId: number;
  serviceTypeId: number | null;
  phaseId: number | null;
  serviceType: Phase | null;
  phase: Service | null;
  assignees: Assignee[];
}

interface ZoneNode {
  id: number;
  name: string;
  zoneType: string;
  projectId: number;
  parentId: number | null;
  children: ZoneNode[];
}

interface Project {
  id: number;
  name: string;
  number: string | null;
  status: string;
}

interface BoardData {
  projects: Project[];
  zones: Record<number, ZoneNode[]>;
  tasks: Task[];
  services: Service[];
  phases: Phase[];
}

interface FlatRow {
  type: 'project' | 'zone';
  id: number;
  key: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  projectId?: number;
  zoneType?: string;
  number?: string | null;
}

function useExecutionBoard(projectId?: number | null, serviceId?: number | null) {
  return useQuery<BoardData>({
    queryKey: ['execution-board', projectId, serviceId],
    queryFn: () =>
      client
        .get('/execution-board', {
          params: {
            ...(projectId ? { projectId } : {}),
            ...(serviceId ? { serviceId } : {}),
          },
        })
        .then((r) => r.data?.data ?? r.data),
  });
}

const DOT_COLOR: Record<string, string> = {
  not_started: 'bg-gray-400',
  in_progress: 'bg-blue-500',
  in_review: 'bg-purple-500',
  completed: 'bg-emerald-500',
  on_hold: 'bg-yellow-500',
  cancelled: 'bg-red-500',
};

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-left shadow-sm transition-colors hover:border-blue-300 hover:shadow"
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_COLOR[task.status] ?? 'bg-gray-400')} />
        <span className="flex-1 truncate text-[12px] font-medium text-slate-700">{task.name}</span>
        <span className="shrink-0 text-[11px] font-semibold text-slate-400">{task.completionPct}%</span>
      </div>
      {task.assignees.length > 0 && (
        <div className="mt-1 flex -space-x-1.5">
          {task.assignees.slice(0, 3).map((a) => (
            <div
              key={a.user.id}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white ring-1 ring-white"
              title={`${a.user.firstName} ${a.user.lastName}`}
            >
              {(a.user.firstName?.[0] ?? '')}{(a.user.lastName?.[0] ?? '')}
            </div>
          ))}
          {task.assignees.length > 3 && (
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-300 text-[9px] font-bold text-slate-600 ring-1 ring-white">
              +{task.assignees.length - 3}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

export function ExecutionBoardPage() {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useExecutionBoard(projectId, serviceId);

  const toggleExpand = useCallback((key: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // DB ServiceType = UI "Phases" (matrix columns)
  const phases = data?.phases ?? [];
  // DB Phase = UI "Services" (filter dropdown)
  const services = data?.services ?? [];

  // Matrix key: zoneId × serviceTypeId (DB field = UI "phase" column)
  const taskMatrix = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of data?.tasks ?? []) {
      const key = `${task.zoneId}-${task.serviceTypeId ?? 0}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(task);
    }
    return map;
  }, [data?.tasks]);

  const flatRows = useMemo(() => {
    if (!data) return [];
    const result: FlatRow[] = [];
    const showProjects = !projectId && data.projects.length > 0;

    function walkZones(nodes: ZoneNode[], baseDepth: number, projectIdCtx: number) {
      for (const z of nodes) {
        const hasChildren = z.children?.length > 0;
        const key = `zone-${z.id}`;
        result.push({
          type: 'zone',
          id: z.id,
          key,
          name: z.name,
          depth: baseDepth,
          hasChildren,
          projectId: projectIdCtx,
          zoneType: z.zoneType,
        });
        if (hasChildren && expandedIds.has(key)) {
          walkZones(z.children, baseDepth + 1, projectIdCtx);
        }
      }
    }

    for (const project of data.projects) {
      const zoneTree = data.zones[project.id] ?? [];
      if (showProjects) {
        const pKey = `project-${project.id}`;
        result.push({
          type: 'project',
          id: project.id,
          key: pKey,
          name: project.name,
          number: project.number,
          depth: 0,
          hasChildren: zoneTree.length > 0,
        });
        if (expandedIds.has(pKey)) {
          walkZones(zoneTree, 1, project.id);
        }
      } else {
        walkZones(zoneTree, 0, project.id);
      }
    }

    return result;
  }, [data, projectId, expandedIds]);

  // Auto-expand all projects on first load
  useMemo(() => {
    if (!data || projectId) return;
    const projectKeys = data.projects.map((p) => `project-${p.id}`);
    setExpandedIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(projectKeys);
    });
  }, [data, projectId]);

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Execution Board"
        description="Zone × Phase task matrix across projects"
      />

      <div className="flex flex-wrap items-center gap-3">
        <ProjectSelect
          value={projectId}
          onChange={setProjectId}
          placeholder="All Projects"
          className="w-64"
        />
        <select
          value={serviceId ?? ''}
          onChange={(e) => setServiceId(e.target.value ? +e.target.value : null)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
        >
          <option value="">All Services</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {flatRows.length === 0 ? (
        <EmptyState
          icon={Grid3X3}
          title={data?.projects.length === 0 ? 'No active projects' : 'No data to display'}
          description={
            data?.projects.length === 0
              ? 'There are no active or on-hold projects to show.'
              : 'Select a project or adjust filters to see the execution board.'
          }
        />
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold min-w-[260px] border-r border-slate-200">
                    Zone
                  </th>
                  {phases.map((phase) => (
                    <th
                      key={phase.id}
                      className="px-3 py-2.5 text-center font-semibold min-w-[180px] border-r border-slate-100 last:border-r-0"
                    >
                      <div className="flex items-center justify-center gap-1.5">
                        {phase.color && (
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: phase.color }}
                          />
                        )}
                        {phase.name}
                      </div>
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-center font-semibold min-w-[180px] text-slate-400">
                    No Phase
                  </th>
                </tr>
              </thead>
              <tbody>
                {flatRows.map((row) => {
                  if (row.type === 'project') {
                    return (
                      <tr
                        key={row.key}
                        className="border-t border-slate-200 bg-slate-50/60 hover:bg-slate-100/60 cursor-pointer"
                        onClick={() => toggleExpand(row.key)}
                      >
                        <td
                          className="sticky left-0 z-10 bg-slate-50/60 px-4 py-2.5 border-r border-slate-200"
                          colSpan={phases.length + 2}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronRight
                              className={cn(
                                'h-4 w-4 text-slate-400 transition-transform duration-150',
                                expandedIds.has(row.key) && 'rotate-90',
                              )}
                            />
                            <FolderKanban className="h-4 w-4 text-blue-500" />
                            <span className="font-semibold text-slate-700">{row.name}</span>
                            {row.number && (
                              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                                {row.number}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr
                      key={row.key}
                      className="border-t border-slate-100 hover:bg-slate-50/40"
                    >
                      <td className="sticky left-0 z-10 bg-white px-4 py-2 border-r border-slate-200">
                        <div
                          className="flex items-center gap-1.5 cursor-pointer"
                          style={{ paddingLeft: `${row.depth * 20}px` }}
                          onClick={() => row.hasChildren && toggleExpand(row.key)}
                        >
                          {row.hasChildren ? (
                            <ChevronRight
                              className={cn(
                                'h-3.5 w-3.5 text-slate-400 transition-transform duration-150 shrink-0',
                                expandedIds.has(row.key) && 'rotate-90',
                              )}
                            />
                          ) : (
                            <span className="w-3.5" />
                          )}
                          <span
                            className={cn(
                              'truncate text-[13px]',
                              row.hasChildren ? 'font-semibold text-slate-700' : 'text-slate-600',
                            )}
                          >
                            {row.name}
                          </span>
                          {row.zoneType && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400 capitalize shrink-0">
                              {row.zoneType}
                            </span>
                          )}
                        </div>
                      </td>
                      {phases.map((phase) => {
                        const cellTasks = taskMatrix.get(`${row.id}-${phase.id}`) ?? [];
                        return (
                          <td
                            key={phase.id}
                            className="px-2 py-1.5 align-top border-r border-slate-100 last:border-r-0"
                          >
                            {cellTasks.length > 0 && (
                              <div className="flex flex-col gap-1">
                                {cellTasks.map((task) => (
                                  <TaskCard
                                    key={task.id}
                                    task={task}
                                    onClick={() => navigate(`/tasks/${task.id}`)}
                                  />
                                ))}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 align-top">
                        {(taskMatrix.get(`${row.id}-0`) ?? []).length > 0 && (
                          <div className="flex flex-col gap-1">
                            {(taskMatrix.get(`${row.id}-0`) ?? []).map((task) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                onClick={() => navigate(`/tasks/${task.id}`)}
                              />
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
