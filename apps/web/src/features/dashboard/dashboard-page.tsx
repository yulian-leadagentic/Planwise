import { useMemo } from 'react';
import {
  CheckSquare,
  Clock,
  FolderKanban,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { useAuthStore } from '@/stores/auth.store';
import { useTasks } from '@/hooks/use-tasks';
import { useClockStatus } from '@/hooks/use-time';
import { useProjects } from '@/hooks/use-projects';
import { minutesToDisplay } from '@/types';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  not_started: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'To Do' },
  in_progress: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'In Progress' },
  in_review: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'In Review' },
  completed: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Done' },
  on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
};

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data: clockStatus } = useClockStatus();
  const { data: tasksData, isLoading: tasksLoading } = useTasks({
    assigneeId: user?.id,
    perPage: 50,
  });
  const { data: projectsData, isLoading: projectsLoading } = useProjects({
    status: 'active',
    perPage: 100,
  });

  if (tasksLoading || projectsLoading) return <PageSkeleton />;

  const rawTasks = tasksData?.data ?? tasksData;
  const tasks: any[] = Array.isArray(rawTasks) ? rawTasks : [];
  const rawProjects = projectsData?.data ?? projectsData;
  const projects: any[] = Array.isArray(rawProjects) ? rawProjects : [];

  // Mini Kanban summary
  const tasksByStatus = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const t of tasks) {
      const s = t.status || 'not_started';
      if (!map[s]) map[s] = [];
      map[s].push(t);
    }
    return map;
  }, [tasks]);

  const activeTasks = tasks.filter((t: any) => t.status !== 'completed' && t.status !== 'cancelled');

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Dashboard"
        description={`Welcome back, ${user?.firstName ?? 'User'} — here's what's happening today`}
      />

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-[14px] border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
              <FolderKanban className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Active Projects</p>
              <p className="text-xl font-semibold text-slate-900">{projects.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-600">
              <CheckSquare className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">My Active Tasks</p>
              <p className="text-xl font-semibold text-slate-900">{activeTasks.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100 text-orange-600">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Today Clock</p>
              <p className="text-xl font-semibold text-slate-900">
                {clockStatus?.isClockedIn ? minutesToDisplay(clockStatus.elapsedMinutes ?? 0) : 'Not clocked in'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Mini Kanban Summary */}
      <div className="rounded-[14px] border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-bold text-slate-900">Task Board Summary</h2>
          <button onClick={() => navigate('/my-tasks')} className="text-[12px] font-semibold text-blue-600 hover:text-blue-700">
            Open Board →
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {['not_started', 'in_progress', 'in_review', 'completed'].map((status) => {
            const cfg = statusColors[status] || statusColors.not_started;
            const count = tasksByStatus[status]?.length ?? 0;
            return (
              <div key={status} className={cn('rounded-lg p-3 text-center', cfg.bg)}>
                <p className="text-2xl font-bold">{count}</p>
                <p className={cn('text-[11px] font-semibold mt-0.5', cfg.text)}>{cfg.label}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tasks List */}
      <div className="rounded-[14px] border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-bold text-slate-900">My Active Tasks</h2>
          <button onClick={() => navigate('/my-tasks')} className="text-[12px] font-semibold text-blue-600 hover:text-blue-700">
            View Board →
          </button>
        </div>
        {activeTasks.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">No active tasks</p>
        ) : (
          <div className="space-y-2">
            {activeTasks.slice(0, 10).map((task: any) => {
              const st = statusColors[task.status] || statusColors.not_started;
              const projectName = task.project?.name || task.label?.projectName || '';
              const zoneName = task.zone?.name || task.label?.name || '';
              return (
                <div
                  key={task.id}
                  onClick={() => navigate(task.projectId ? `/projects/${task.projectId}` : '/my-tasks')}
                  className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white p-3 hover:border-blue-200 hover:bg-blue-50/20 cursor-pointer transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-800">{task.name}</p>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                      {projectName && <span className="font-medium text-blue-600">{projectName}</span>}
                      {zoneName && <span>{zoneName}</span>}
                    </div>
                  </div>
                  <span className={cn('rounded-[5px] px-2 py-0.5 text-[10px] font-bold shrink-0', st.bg, st.text)}>
                    {st.label}
                  </span>
                </div>
              );
            })}
            {activeTasks.length > 10 && (
              <p className="text-center text-[12px] text-slate-400">
                +{activeTasks.length - 10} more tasks
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
