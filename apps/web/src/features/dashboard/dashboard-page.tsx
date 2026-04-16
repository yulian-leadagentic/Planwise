import {
  CheckSquare,
  Clock,
  FolderKanban,
  TrendingUp,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { BarChart } from '@/components/charts/bar-chart';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { useAuthStore } from '@/stores/auth.store';
import { useTasks } from '@/hooks/use-tasks';
import { useClockStatus } from '@/hooks/use-time';
import { useProjects } from '@/hooks/use-projects';
import { minutesToDisplay } from '@/types';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { formatDate } from '@/lib/date-utils';

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { data: clockStatus } = useClockStatus();
  const { data: tasksData, isLoading: tasksLoading } = useTasks({
    assigneeId: user?.id,
    perPage: 20,
  });
  const { data: projectsData, isLoading: projectsLoading } = useProjects({
    status: 'active',
    perPage: 100,
  });

  if (tasksLoading || projectsLoading) {
    return <PageSkeleton />;
  }

  const tasks = tasksData?.data ?? [];
  const projects = projectsData?.data ?? [];

  const stats = [
    {
      label: 'Active Projects',
      value: projects.length,
      icon: FolderKanban,
      color: 'bg-blue-100 text-blue-600',
    },
    {
      label: 'My Tasks',
      value: tasks.length,
      icon: CheckSquare,
      color: 'bg-green-100 text-green-600',
    },
    {
      label: 'Today Clock',
      value: clockStatus?.isClockedIn
        ? minutesToDisplay(clockStatus.elapsedMinutes ?? 0)
        : 'Not clocked in',
      icon: Clock,
      color: 'bg-orange-100 text-orange-600',
    },
    {
      label: 'Expected Today',
      value: clockStatus?.expectedMinutes
        ? minutesToDisplay(clockStatus.expectedMinutes)
        : '-',
      icon: TrendingUp,
      color: 'bg-purple-100 text-purple-600',
    },
  ];

  // Mock weekly chart data
  const weeklyData = [
    { day: 'Mon', hours: 7.5 },
    { day: 'Tue', hours: 8 },
    { day: 'Wed', hours: 6.5 },
    { day: 'Thu', hours: 8 },
    { day: 'Fri', hours: 4 },
    { day: 'Sat', hours: 0 },
    { day: 'Sun', hours: 0 },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Dashboard"
        description={`Welcome back, ${user?.firstName ?? 'User'} — here's what's happening today`}
      />

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-border bg-background p-4"
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${stat.color}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className="text-xl font-semibold">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent tasks */}
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">My Tasks</h2>
            <button
              onClick={() => navigate('/tasks')}
              className="text-sm text-brand-600 hover:text-brand-700"
            >
              View all
            </button>
          </div>
          <div className="space-y-3">
            {tasks.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No active tasks
              </p>
            ) : (
              tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => navigate(task.projectId ? `/projects/${task.projectId}` : `/tasks/${task.id}`)}
                  className="flex w-full items-center justify-between rounded-md border border-border p-3 text-left hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{task.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {task.label?.projectName} / {task.label?.name}
                    </p>
                  </div>
                  <div className="ml-3 flex items-center gap-2">
                    <PriorityBadge priority={task.priority} />
                    <StatusBadge status={task.status} />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Weekly time summary */}
        <div className="rounded-lg border border-border bg-background p-4">
          <h2 className="mb-4 font-semibold">This Week</h2>
          <BarChart
            data={weeklyData}
            xKey="day"
            bars={[{ key: 'hours', color: 'hsl(var(--primary))', name: 'Hours' }]}
            height={250}
            showLegend={false}
          />
        </div>
      </div>
    </div>
  );
}
