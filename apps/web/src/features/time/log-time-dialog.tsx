import { useState, useEffect } from 'react';
import { X, Search, Clock, FolderKanban, ListChecks } from 'lucide-react';
import { useProjects } from '@/hooks/use-projects';
import { useCreateTimeEntry } from '@/hooks/use-time';
import { MinutesInput } from '@/components/shared/minutes-input';
import { useDebounce } from '@/hooks/use-debounce';
import { format } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { useQuery } from '@tanstack/react-query';

interface LogTimeDialogProps {
  open: boolean;
  onClose: () => void;
  defaultDate?: string;
  defaultProjectId?: number;
  defaultTaskId?: number;
}

export function LogTimeDialog({
  open,
  onClose,
  defaultDate,
  defaultProjectId,
  defaultTaskId,
}: LogTimeDialogProps) {
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId ?? null);
  const [taskId, setTaskId] = useState<number | null>(defaultTaskId ?? null);
  const [date, setDate] = useState(defaultDate ?? format(new Date(), 'yyyy-MM-dd'));
  const [minutes, setMinutes] = useState(0);
  const [note, setNote] = useState('');
  const [isBillable, setIsBillable] = useState(true);
  const [projectSearch, setProjectSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');

  const debouncedProjectSearch = useDebounce(projectSearch, 300);
  const debouncedTaskSearch = useDebounce(taskSearch, 300);

  const createEntry = useCreateTimeEntry();

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? null);
      setTaskId(defaultTaskId ?? null);
      setDate(defaultDate ?? format(new Date(), 'yyyy-MM-dd'));
      setMinutes(0);
      setNote('');
      setIsBillable(true);
      setProjectSearch('');
      setTaskSearch('');
    }
  }, [open, defaultDate, defaultProjectId, defaultTaskId]);

  // Fetch projects
  const { data: projectsData } = useProjects({ search: debouncedProjectSearch, perPage: 50 });
  const projects = projectsData?.data ?? [];

  // Fetch tasks for selected project
  const { data: tasksData } = useQuery({
    queryKey: ['tasks', { projectId, search: debouncedTaskSearch }],
    queryFn: () =>
      client
        .get('/tasks', { params: { projectId, search: debouncedTaskSearch || undefined, perPage: 100 } })
        .then((r) => r.data.data ?? r.data),
    enabled: !!projectId,
  });
  const tasks = tasksData ?? [];

  const selectedProject = projects.find((p: any) => p.id === projectId);
  const selectedTask = tasks.find((t: any) => t.id === taskId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (minutes <= 0) return;

    createEntry.mutate(
      {
        projectId: projectId ?? undefined,
        taskId: taskId ?? undefined,
        date,
        minutes,
        note: note.trim() || undefined,
        isBillable,
      },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-lg rounded-[14px] border border-border bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-brand-600" />
            <h2 className="text-base font-semibold">Log Time</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {/* Date */}
          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Project selector */}
          <div>
            <label className="mb-1 block text-sm font-medium">Project</label>
            {projectId && selectedProject ? (
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
                <FolderKanban className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-sm">{selectedProject.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setProjectId(null);
                    setTaskId(null);
                    setTaskSearch('');
                  }}
                  className="rounded p-0.5 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <div className="rounded-md border border-input bg-background">
                <div className="flex items-center gap-2 border-b border-input px-3 py-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    placeholder="Search projects..."
                    className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    autoFocus
                  />
                </div>
                <div className="max-h-40 overflow-y-auto py-1">
                  {projects.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No projects found</p>
                  ) : (
                    projects.map((p: any) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setProjectId(p.id);
                          setProjectSearch('');
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                      >
                        <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
                        {p.name}
                        {p.number && (
                          <span className="text-xs text-muted-foreground">({p.number})</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Task selector (only when project selected) */}
          {projectId && (
            <div>
              <label className="mb-1 block text-sm font-medium">Task</label>
              {taskId && selectedTask ? (
                <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
                  <ListChecks className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm">{selectedTask.name}</span>
                    {selectedTask.zone && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({selectedTask.zone?.name})
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTaskId(null)}
                    className="rounded p-0.5 hover:bg-accent"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-input bg-background">
                  <div className="flex items-center gap-2 border-b border-input px-3 py-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={taskSearch}
                      onChange={(e) => setTaskSearch(e.target.value)}
                      placeholder="Search tasks..."
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  <div className="max-h-40 overflow-y-auto py-1">
                    {tasks.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        {projectId ? 'No tasks found for this project' : 'Select a project first'}
                      </p>
                    ) : (
                      tasks.map((t: any) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setTaskId(t.id);
                            setTaskSearch('');
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                        >
                          <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                          <div className="min-w-0 text-left">
                            <span className="truncate">{t.name}</span>
                            {t.zone && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {t.zone.name}
                              </span>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Duration */}
          <div>
            <label className="mb-1 block text-sm font-medium">Duration *</label>
            <MinutesInput
              value={minutes}
              onChange={setMinutes}
              placeholder="e.g. 2h 30m"
              className="w-full"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Enter as hours and minutes (e.g. 2h 30m, 1.5h, 90m)
            </p>
          </div>

          {/* Note */}
          <div>
            <label className="mb-1 block text-sm font-medium">Note</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you work on?"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Billable toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(e) => setIsBillable(e.target.checked)}
              className="h-4 w-4 rounded border-input text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm">Billable</span>
          </label>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={minutes <= 0 || createEntry.isPending}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {createEntry.isPending ? 'Saving...' : 'Log Time'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
