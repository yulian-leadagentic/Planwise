import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Users, FolderTree, CheckSquare, DollarSign, LayoutGrid, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { UserAvatar } from '@/components/shared/user-avatar';
import { ProjectTree } from './project-tree';
import { PlanningTab } from './planning-modal';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useProject, useProjectMembers } from '@/hooks/use-projects';
import { useLabelTree } from '@/hooks/use-labels';
import { useTasks } from '@/hooks/use-tasks';
import { formatDate } from '@/lib/date-utils';
import { formatCurrency, cn } from '@/lib/utils';

type Tab = 'tree' | 'planning' | 'tasks' | 'members' | 'costs';

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
    { key: 'planning' as Tab, label: 'Planning', icon: LayoutGrid },
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

      {tab === 'planning' && (
        <ErrorBoundary onClose={() => setTab('tree')}>
          <PlanningTab projectId={projectId} />
        </ErrorBoundary>
      )}

      {tab === 'tasks' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => navigate(`/tasks`)}
              className="flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> View All Tasks
            </button>
          </div>
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet. Use the Planning tab to create services for this project.</p>
          ) : (
            tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(`/tasks/${task.id}`)}
                className="flex w-full items-center justify-between rounded-md border border-border p-3 text-left hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{task.zone?.name || task.code}</p>
                </div>
                <StatusBadge status={task.status} />
              </button>
            ))
          )}
        </div>
      )}

      {tab === 'members' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button className="flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" onClick={() => toast.info('Member management coming soon')}>
              <Plus className="h-4 w-4" /> Add Member
            </button>
          </div>
          {!members || members.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No members yet. Add team members to this project.</p>
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

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose: () => void },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode; onClose: () => void }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-red-600">Planning view encountered an error</p>
          <p className="mt-1 text-xs text-muted-foreground">{this.state.error}</p>
          <button onClick={this.props.onClose} className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            Go Back
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
