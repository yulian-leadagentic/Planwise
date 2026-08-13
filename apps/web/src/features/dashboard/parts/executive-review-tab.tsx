import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Download, ExternalLink, MessageSquare, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { tasksApi } from '@/api/tasks.api';
import { notify } from '@/lib/notify';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import { OpsAvatar, OpsErrorBanner, opsErrorMessage } from './ops-shared';

/**
 * Executive Review tab (feat/ops-complete).
 *
 * Server-side capped task list (default 200, max 500) with a Comment
 * column persisted per-task via TaskOpsNote. Group-by, filter and
 * sort operate on the current page. CSV export writes the current
 * VIEW (filters + group applied), not the raw response — that matches
 * what the operator actually sees on-screen.
 *
 * Comment column is inline-editable. Save on blur or Enter; Escape
 * cancels; empty content clears the note server-side. Optimistic-ish:
 * the mutation invalidates the tab's cache on success rather than
 * patching a single cell — the whole tab is 200 rows max, so the
 * refetch is cheap and stays honest to the server's canonical state.
 */

type OpsNote = {
  content: string;
  updatedAt: string;
  updatedBy: { id: number; firstName: string | null; lastName: string | null } | null;
} | null;

type ExecTask = {
  id: number; code: string; name: string;
  status: string; priority: string;
  hours: number;
  startDate: string | null;
  endDate: string | null;
  daysOverdue: number | null;
  zone: { id: number; name: string } | null;
  project: {
    id: number; name: string; number: string | null;
    department: { id: number; name: string } | null;
  } | null;
  phase: { id: number; name: string } | null;
  service: { id: number; name: string; code: string | null; color: string | null } | null;
  assignees: Array<{ id: number; firstName: string | null; lastName: string | null; avatarUrl: string | null }>;
  opsNote: OpsNote;
};

type ExecutiveReviewResponse = {
  tasks: ExecTask[];
  totalCount: number;
  take: number;
  scope: { myDeptOnly: boolean; deptName: string | null };
};

type GroupBy = 'none' | 'project' | 'department' | 'service' | 'priority' | 'status';

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  none: 'None',
  project: 'Project',
  department: 'Department',
  service: 'Service',
  priority: 'Priority',
  status: 'Status',
};

function groupKey(t: ExecTask, g: GroupBy): string {
  switch (g) {
    case 'project': return t.project?.name ?? '(no project)';
    case 'department': return t.project?.department?.name ?? '(no department)';
    case 'service': return t.service?.name ?? '(no service)';
    case 'priority': return t.priority;
    case 'status': return t.status;
    default: return '';
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return '—'; }
}

// Minimal CSV escaping — quote every field, double-up embedded quotes.
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCSV(tasks: ExecTask[]): string {
  const header = [
    'code', 'name', 'status', 'priority', 'hours',
    'startDate', 'endDate', 'daysOverdue',
    'project', 'projectNumber', 'department',
    'zone', 'phase', 'service', 'assignees', 'opsNote',
  ];
  const rows = tasks.map((t) => [
    t.code, t.name, t.status, t.priority, t.hours,
    fmtDate(t.startDate), fmtDate(t.endDate), t.daysOverdue ?? '',
    t.project?.name ?? '', t.project?.number ?? '', t.project?.department?.name ?? '',
    t.zone?.name ?? '', t.phase?.name ?? '', t.service?.name ?? '',
    t.assignees.map((a) => `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim()).join('; '),
    t.opsNote?.content ?? '',
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function ExecutiveReviewTab({
  myDeptOnly,
  onOpenTask,
  onOpenProject,
}: {
  myDeptOnly: boolean;
  onOpenTask: (taskId: number) => void;
  onOpenProject: (projectId: number) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ExecutiveReviewResponse>({
    queryKey: ['dashboard', 'operations', 'executive-review', { myDeptOnly }],
    queryFn: () => client
      .get('/dashboard/operations/executive-review', { params: myDeptOnly ? { myDeptOnly: true } : {} })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    retry: 1,
  });

  const noteMutation = useMutation({
    mutationFn: async ({ taskId, content }: { taskId: number; content: string }) => {
      return client
        .post(`/dashboard/operations/tasks/${taskId}/ops-note`, { content })
        .then((r) => r.data?.data ?? r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', 'operations', 'executive-review'] });
    },
  });

  // Inline Due-date edit (bm2 fix #5). Persists via the same tasksApi
  // endpoint used by the planning grid + task drawer, so any listener
  // downstream (activity log, planning refetch) sees the change. Empty
  // string clears the date. Refetches on success — the tab is server-
  // capped at ~200 rows so a full invalidate is cheap.
  const dueDateMutation = useMutation({
    mutationFn: ({ taskId, endDate }: { taskId: number; endDate: string | null }) =>
      tasksApi.update(taskId, { endDate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', 'operations', 'executive-review'] });
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to update due date'),
  });

  const tasks = data?.tasks ?? [];
  const filtered = useMemo(() => {
    if (!search) return tasks;
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      const hay = [
        t.code, t.name, t.project?.name ?? '', t.project?.number ?? '',
        t.zone?.name ?? '', t.service?.name ?? '',
        t.assignees.map((a) => `${a.firstName ?? ''} ${a.lastName ?? ''}`).join(' '),
        t.opsNote?.content ?? '',
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [tasks, search]);

  const grouped = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', tasks: filtered }];
    const map = new Map<string, ExecTask[]>();
    for (const t of filtered) {
      const key = groupKey(t, groupBy);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, tasks]) => ({ key, tasks }));
  }, [filtered, groupBy]);

  const commitNote = (taskId: number) => {
    const value = editDraft.trim();
    // No-op if the draft equals what's already stored (avoids
    // pointless writes when the operator just clicks a cell).
    const existing = tasks.find((t) => t.id === taskId)?.opsNote?.content ?? '';
    if (value !== existing) {
      noteMutation.mutate({ taskId, content: value });
    }
    setEditingTaskId(null);
    setEditDraft('');
  };

  const downloadCSV = () => {
    const csv = toCSV(filtered);
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `executive-review-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <PageSkeleton />;
  if (isError) {
    return (
      <OpsErrorBanner
        title="Could not load executive review"
        message={opsErrorMessage(error)}
        onRetry={() => refetch()}
      />
    );
  }

  const showingMore = (data?.totalCount ?? 0) > (data?.take ?? 0);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by task, project, assignee, comment…"
          className="flex-1 min-w-[200px] text-[12px] outline-none bg-transparent placeholder:text-slate-400"
          aria-label="Filter executive review"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear filter"
            className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-100 flex items-center gap-1"
          >
            <X className="h-3 w-3" aria-hidden="true" />clear
          </button>
        )}
        <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-700 pl-3">
          <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400" htmlFor="exec-group">
            Group
          </label>
          <select
            id="exec-group"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="text-[12px] bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 focus:outline-none focus-visible:border-blue-500"
          >
            {(Object.keys(GROUP_BY_LABEL) as GroupBy[]).map((g) => (
              <option key={g} value={g}>{GROUP_BY_LABEL[g]}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={downloadCSV}
          disabled={filtered.length === 0}
          aria-label="Download current view as CSV"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:border-blue-500"
        >
          <Download className="h-3 w-3" aria-hidden="true" />
          CSV
        </button>
        <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500 font-mono tabular-nums">
          {showingMore
            ? `Showing first ${data?.take ?? 0} of ${data?.totalCount ?? 0}`
            : `${data?.totalCount ?? 0} task${(data?.totalCount ?? 0) === 1 ? '' : 's'}`}
        </span>
      </div>

      {isFetching && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 -mt-1">Refreshing…</p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <EmptyState
            icon={ClipboardList}
            title="No tasks to review"
            description={search ? `No tasks matching "${search}".` : 'The executive review queue is empty for the current scope.'}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <div key={g.key || 'ungrouped'}>
              {g.key && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-1 h-4 rounded-sm bg-indigo-500" />
                  <h3 className="text-[13px] font-bold text-slate-900 dark:text-slate-100">{g.key}</h3>
                  <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 font-mono tabular-nums">— {g.tasks.length}</span>
                </div>
              )}
              <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] min-w-[960px]">
                    <thead className="bg-[#FAFBFC] dark:bg-slate-800/60 border-b border-slate-100 dark:border-slate-800">
                      <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        <th className="px-3 py-2 w-[110px]">Code</th>
                        <th className="px-3 py-2">Task</th>
                        <th className="px-3 py-2 w-[160px]">Project</th>
                        <th className="px-3 py-2 w-[100px]">Status</th>
                        <th className="px-3 py-2 w-[90px]">Priority</th>
                        <th className="px-3 py-2 w-[70px] text-right">Hours</th>
                        <th className="px-3 py-2 w-[110px]">Due</th>
                        <th className="px-3 py-2 w-[130px]">Assignee</th>
                        <th className="px-3 py-2 w-[260px]">Comment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {g.tasks.map((t) => {
                        const isEditing = editingTaskId === t.id;
                        const noteText = t.opsNote?.content ?? '';
                        return (
                          <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60 group align-top">
                            <td className="px-3 py-2 text-slate-500 dark:text-slate-400 font-mono tabular-nums whitespace-nowrap">
                              {t.code}
                            </td>
                            <td className="px-3 py-2 min-w-0">
                              <button
                                type="button"
                                onClick={() => onOpenTask(t.id)}
                                className="text-left font-semibold text-slate-800 dark:text-slate-100 hover:text-blue-700 hover:underline truncate max-w-[300px] block focus-visible:outline-none focus-visible:border-blue-500"
                              >
                                {t.name}
                              </button>
                              {t.zone && <span className="text-[10px] text-slate-400 dark:text-slate-500">{t.zone.name}</span>}
                            </td>
                            <td className="px-3 py-2 min-w-0">
                              {t.project ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenProject(t.project!.id)}
                                  className="text-left text-[12px] text-slate-700 dark:text-slate-200 hover:text-blue-700 hover:underline truncate max-w-[160px] block focus-visible:outline-none focus-visible:border-blue-500"
                                >
                                  {t.project.name}
                                </button>
                              ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                            </td>
                            <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                            <td className="px-3 py-2"><PriorityBadge priority={t.priority} /></td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                              {t.hours || 0}h
                            </td>
                            {/* Due date — inline-editable (bm2 fix #5).
                                Change fires an onBlur PATCH via tasksApi.
                                Empty string clears the date. Overdue
                                pill still renders alongside so operators
                                see the "d late" signal at a glance. */}
                            <td className="px-3 py-2 text-[11px] whitespace-nowrap">
                              <input
                                type="date"
                                defaultValue={t.endDate ? String(t.endDate).slice(0, 10) : ''}
                                onBlur={(e) => {
                                  const nextValue = e.target.value || null;
                                  const currentValue = t.endDate ? String(t.endDate).slice(0, 10) : null;
                                  if (nextValue === currentValue) return;
                                  dueDateMutation.mutate({ taskId: t.id, endDate: nextValue });
                                }}
                                aria-label={`Due date for task ${t.code}`}
                                disabled={dueDateMutation.isPending}
                                className={cn(
                                  'w-full px-1.5 py-1 rounded border font-mono tabular-nums text-[11px] bg-transparent focus:outline-none focus-visible:border-blue-500 disabled:opacity-50',
                                  t.daysOverdue != null && t.daysOverdue > 0
                                    ? 'border-red-200 text-red-600 font-bold'
                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
                                )}
                              />
                              {t.daysOverdue != null && t.daysOverdue > 0 && (
                                <div className="text-[10px] font-bold text-red-600 mt-0.5">{t.daysOverdue}d late</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {t.assignees.length > 0 ? (
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <OpsAvatar firstName={t.assignees[0].firstName} lastName={t.assignees[0].lastName} size={20} />
                                  <span className="text-[12px] text-slate-700 dark:text-slate-200 truncate">
                                    {t.assignees[0].firstName} {t.assignees[0].lastName?.[0]}.
                                    {t.assignees.length > 1 && (
                                      <span className="ml-1 text-[10px] text-slate-400 dark:text-slate-500">
                                        +{t.assignees.length - 1}
                                      </span>
                                    )}
                                  </span>
                                </div>
                              ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                            </td>
                            <td className="px-3 py-2 max-w-[280px]">
                              {isEditing ? (
                                <textarea
                                  value={editDraft}
                                  onChange={(e) => setEditDraft(e.target.value)}
                                  onBlur={() => commitNote(t.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      setEditingTaskId(null);
                                      setEditDraft('');
                                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                      commitNote(t.id);
                                    }
                                  }}
                                  autoFocus
                                  rows={2}
                                  className="w-full text-[12px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-2 py-1.5 focus:outline-none focus-visible:border-blue-500 resize-y"
                                  aria-label={`Ops comment for task ${t.code}`}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingTaskId(t.id);
                                    setEditDraft(noteText);
                                  }}
                                  aria-label={noteText ? `Edit ops comment for task ${t.code}` : `Add ops comment for task ${t.code}`}
                                  className={cn(
                                    'block text-left w-full rounded-lg px-2 py-1 transition-colors focus-visible:outline-none focus-visible:border-blue-500 border border-transparent',
                                    noteText
                                      ? 'text-slate-700 dark:text-slate-200 hover:border-slate-200 dark:hover:border-slate-700'
                                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 hover:border-slate-200 dark:hover:border-slate-700 italic',
                                  )}
                                >
                                  {noteText ? (
                                    <span className="line-clamp-2 whitespace-pre-wrap break-words text-[12px]">{noteText}</span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[11px]">
                                      <MessageSquare className="h-3 w-3" aria-hidden="true" />add comment
                                    </span>
                                  )}
                                  {t.opsNote?.updatedBy && (
                                    <span className="block text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 not-italic">
                                      — {t.opsNote.updatedBy.firstName} {t.opsNote.updatedBy.lastName?.[0]}. · <span className="font-mono tabular-nums">{fmtDate(t.opsNote.updatedAt)}</span>
                                    </span>
                                  )}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-end gap-2 px-3 py-1.5 text-[11px] text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-800">
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span>Click a task or project name to open the drawer / detail page.</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
