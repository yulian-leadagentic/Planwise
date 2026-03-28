import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Users, FolderTree, CheckSquare, DollarSign } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { ProjectTree } from './project-tree';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useProject, useProjectMembers } from '@/hooks/use-projects';
import { useLabelTree } from '@/hooks/use-labels';
import { useTasks } from '@/hooks/use-tasks';
import { formatDate } from '@/lib/date-utils';
import { formatCurrency, cn } from '@/lib/utils';

type Tab = 'tree' | 'tasks' | 'members' | 'costs';

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const projectId = Number(id);
  const [tab, setTab] = useState<Tab>('tree');

  const { data: project, isLoading } = useProject(projectId);
  const { data: tree } = useLabelTree(projectId);
  const { data: members } = useProjectMembers(projectId);
  const { data: tasksData } = useTasks({ projectId, perPage: 100 });

  if (isLoading) return <PageSkeleton />;
  if (!project) return <p className="py-8 text-center text-muted-foreground">Project not found</p>;

  const tasks = tasksData?.data ?? [];

  const tabs = [
    { key: 'tree' as Tab, label: 'Labels', icon: FolderTree },
    { key: 'tasks' as Tab, label: 'Tasks', icon: CheckSquare, count: tasks.length },
    { key: 'members' as Tab, label: 'Members', icon: Users, count: members?.length },
    { key: 'costs' as Tab, label: 'Costs', icon: DollarSign },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/projects')} className="rounded-md p-1.5 hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <PageHeader
          title={project.name}
          description={project.description ?? undefined}
          actions={
            <div className="flex items-center gap-2">
              <StatusBadge status={project.status} />
              <button
                onClick={() => navigate(`/projects/${projectId}/edit`)}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <Edit className="h-4 w-4" />
                Edit
              </button>
            </div>
          }
          className="flex-1"
        />
      </div>

      {/* Project info */}
      <div className="grid gap-3 sm:grid-cols-4">
        {project.number && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Number</p>
            <p className="text-sm font-medium">{project.number}</p>
          </div>
        )}
        {project.budget != null && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Budget</p>
            <p className="text-sm font-medium">{formatCurrency(project.budget)}</p>
          </div>
        )}
        {project.startDate && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Start Date</p>
            <p className="text-sm font-medium">{formatDate(project.startDate)}</p>
          </div>
        )}
        {project.endDate && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">End Date</p>
            <p className="text-sm font-medium">{formatDate(project.endDate)}</p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
            {t.count != null && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'tree' && (
        <div>
          {tree && tree.length > 0 ? (
            <ProjectTree labels={tree} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No labels yet. Create a label structure to organize this project.
            </p>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="space-y-2">
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet</p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(`/tasks/${task.id}`)}
                className="flex w-full items-center justify-between rounded-md border border-border p-3 text-left hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{task.label?.path}</p>
                </div>
                <StatusBadge status={task.status} />
              </button>
            ))
          )}
        </div>
      )}

      {tab === 'members' && (
        <div className="space-y-2">
          {!members || members.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No members</p>
          ) : (
            members.map((member) => (
              <div key={member.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                <UserAvatar
                  firstName={member.user?.firstName ?? ''}
                  lastName={member.user?.lastName ?? ''}
                  avatarUrl={member.user?.avatarUrl}
                  size="sm"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {member.user?.firstName} {member.user?.lastName}
                  </p>
                  {member.role && <p className="text-xs text-muted-foreground">{member.role}</p>}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'costs' && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Cost overview coming soon
        </div>
      )}
    </div>
  );
}
