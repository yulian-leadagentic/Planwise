import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Filter, ChevronDown, ChevronRight } from 'lucide-react';
import { MessagePanel } from './message-panel';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/date-utils';
import client from '@/api/client';

interface ProjectDiscussionProps {
  projectId: number;
}

export function ProjectDiscussion({ projectId }: ProjectDiscussionProps) {
  const [activeSection, setActiveSection] = useState<'project' | number>('project');
  const [filter, setFilter] = useState<'all' | 'project' | 'tasks'>('all');

  // Fetch project-level messages
  const { data: projectMsgs } = useQuery({
    queryKey: ['messages', 'project', projectId],
    queryFn: () => client.get('/messages', { params: { entityType: 'project', entityId: projectId } }).then((r) => r.data),
  });
  const projectMsgCount = (projectMsgs as any)?.meta?.total ?? 0;

  // Fetch all tasks for this project to show their discussions
  const { data: planningData } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => client.get(`/projects/${projectId}/planning-data`).then((r) => r.data),
  });
  const pd = (planningData as any)?.data ?? planningData;
  const tasks = pd?.tasks ?? [];

  // Fetch message counts per task (lightweight)
  const { data: taskMsgCounts = {} } = useQuery({
    queryKey: ['messages', 'task-counts', projectId],
    queryFn: async () => {
      const counts: Record<number, number> = {};
      // For efficiency, we check first 50 tasks
      for (const task of tasks.slice(0, 50)) {
        try {
          const r = await client.get('/messages', {
            params: { entityType: 'task', entityId: task.id, perPage: 1 },
          });
          const total = (r.data as any)?.meta?.total ?? (r.data as any)?.data?.meta?.total ?? 0;
          if (total > 0) counts[task.id] = total;
        } catch { /* skip */ }
      }
      return counts;
    },
    enabled: tasks.length > 0,
    staleTime: 60 * 1000,
  });

  const tasksWithDiscussions = useMemo(() => {
    return tasks.filter((t: any) => (taskMsgCounts as any)[t.id] > 0);
  }, [tasks, taskMsgCounts]);

  return (
    <div className="space-y-4">
      {/* Section selector sidebar + content */}
      <div className="flex gap-4">
        {/* Left: thread selector */}
        <div className="w-64 shrink-0 space-y-1">
          <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 mb-2">Discussions</h3>

          {/* Project-level */}
          <button
            onClick={() => setActiveSection('project')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[13px] transition-colors',
              activeSection === 'project' ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-700 hover:bg-slate-50',
            )}
          >
            <MessageSquare className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">Project Discussion</span>
            {projectMsgCount > 0 && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">
                {projectMsgCount}
              </span>
            )}
          </button>

          {/* Task-level discussions */}
          {tasksWithDiscussions.length > 0 && (
            <>
              <div className="h-px bg-slate-100 my-2" />
              <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-2 mb-1">
                Task Discussions ({tasksWithDiscussions.length})
              </h3>
              {tasksWithDiscussions.map((task: any) => (
                <button
                  key={task.id}
                  onClick={() => setActiveSection(task.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[13px] transition-colors',
                    activeSection === task.id ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-50',
                  )}
                >
                  <span className="w-4 h-4 rounded bg-slate-200 text-slate-500 text-[8px] font-bold flex items-center justify-center shrink-0">T</span>
                  <span className="flex-1 truncate">{task.name}</span>
                  <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                    {(taskMsgCounts as any)[task.id]}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* Tasks without discussions */}
          {tasks.length > tasksWithDiscussions.length && (
            <>
              <div className="h-px bg-slate-100 my-2" />
              <p className="text-[10px] text-slate-400 px-2">
                {tasks.length - tasksWithDiscussions.length} tasks have no discussions yet.
                Open a task's 💬 icon to start one.
              </p>
            </>
          )}
        </div>

        {/* Right: message panel */}
        <div className="flex-1 min-w-0">
          {activeSection === 'project' ? (
            <div className="rounded-[14px] border border-slate-200 bg-white p-5">
              <MessagePanel entityType="project" entityId={projectId} />
            </div>
          ) : (
            <div className="rounded-[14px] border border-slate-200 bg-white p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px]">
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">TASK</span>
                <span className="font-semibold text-slate-800">
                  {tasks.find((t: any) => t.id === activeSection)?.name ?? 'Task'}
                </span>
              </div>
              <MessagePanel entityType="task" entityId={activeSection as number} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
