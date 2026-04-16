import { useState, useEffect, useRef } from 'react';
import { X, Clock, Paperclip, MessageSquare, UserPlus, ChevronDown } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { tasksApi } from '@/api/tasks.api';
import { timeApi } from '@/api/time.api';
import { formatDate, formatRelative } from '@/lib/date-utils';
import client from '@/api/client';

interface TaskDrawerProps {
  taskId: number | null;
  onClose: () => void;
}

const STATUS_OPTIONS = ['not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

const statusColors: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-600', in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-violet-100 text-violet-700', completed: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-amber-100 text-amber-700', cancelled: 'bg-red-100 text-red-700',
};

const priorityColors: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600', medium: 'bg-blue-100 text-blue-700',
  high: 'bg-amber-100 text-amber-700', critical: 'bg-red-100 text-red-700',
};

export function TaskDrawer({ taskId, onClose }: TaskDrawerProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'details' | 'time' | 'discussion'>('details');
  const drawerRef = useRef<HTMLDivElement>(null);

  const { data: task, isLoading } = useQuery({
    queryKey: ['tasks', taskId],
    queryFn: () => tasksApi.get(taskId!),
    enabled: !!taskId,
  });

  // Focus trap + close on Escape
  useEffect(() => {
    if (!taskId) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [taskId, onClose]);

  const updateTask = useMutation({
    mutationFn: ({ field, value }: { field: string; value: any }) =>
      tasksApi.update(taskId!, { [field]: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['planning'] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update'),
  });

  if (!taskId) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div ref={drawerRef} className="fixed inset-y-0 right-0 z-50 w-[520px] max-w-[90vw] bg-white border-l border-slate-200 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-bold text-slate-900 truncate">
            {isLoading ? 'Loading...' : (task as any)?.name || 'Task'}
          </h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Loading task...</div>
        ) : !task ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Task not found</div>
        ) : (
          <>
            {/* Task code + quick status */}
            <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
              {(task as any).code && <span className="font-mono text-[11px] text-slate-400">{(task as any).code}</span>}
              <select value={(task as any).status} onChange={(e) => updateTask.mutate({ field: 'status', value: e.target.value })}
                className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', statusColors[(task as any).status] || statusColors.not_started)}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
              </select>
              <select value={(task as any).priority} onChange={(e) => updateTask.mutate({ field: 'priority', value: e.target.value })}
                className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold border-0 cursor-pointer focus:outline-none', priorityColors[(task as any).priority] || priorityColors.medium)}>
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 px-5">
              {[
                { key: 'details' as const, label: 'Details' },
                { key: 'time' as const, label: 'Time', icon: Clock },
                { key: 'discussion' as const, label: 'Discussion', icon: MessageSquare },
              ].map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={cn('border-b-2 px-3 py-2 text-xs font-semibold transition-colors flex items-center gap-1',
                    tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600')}>
                  {t.icon && <t.icon className="h-3 w-3" />}
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {tab === 'details' && <TaskDetailsTab task={task as any} onUpdate={(f, v) => updateTask.mutate({ field: f, value: v })} />}
              {tab === 'time' && <TaskTimeTab taskId={taskId!} taskName={(task as any).name} />}
              {tab === 'discussion' && <TaskDiscussionTab taskId={taskId!} />}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TaskDetailsTab({ task, onUpdate }: { task: any; onUpdate: (field: string, value: any) => void }) {
  return (
    <div className="space-y-4">
      {/* Description */}
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase">Description</label>
        <p className="mt-1 text-[13px] text-slate-600">{task.description || <span className="italic text-slate-400">No description</span>}</p>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase">Est. Hours</label>
          <input type="number" value={task.budgetHours ?? ''} onBlur={(e) => onUpdate('budgetHours', e.target.value ? Number(e.target.value) : null)}
            onChange={() => {}} className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase">Amount</label>
          <input type="number" value={task.budgetAmount ?? ''} onBlur={(e) => onUpdate('budgetAmount', e.target.value ? Number(e.target.value) : null)}
            onChange={() => {}} className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase">Due Date</label>
          <input type="date" value={task.endDate?.split('T')[0] ?? ''} onChange={(e) => onUpdate('endDate', e.target.value || undefined)}
            className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-slate-400 uppercase">Completion</label>
          <input type="number" min="0" max="100" value={task.completionPct ?? 0} onBlur={(e) => onUpdate('completionPct', Number(e.target.value))}
            onChange={() => {}} className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
        </div>
      </div>

      {/* Assignees */}
      <div>
        <label className="text-[11px] font-semibold text-slate-400 uppercase">Assignees</label>
        <div className="mt-1 space-y-1">
          {(task.assignees ?? []).length === 0 ? (
            <p className="text-[12px] text-slate-400 italic">No assignees</p>
          ) : (
            task.assignees.map((a: any) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5">
                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                  {(a.user?.firstName?.[0] ?? '') + (a.user?.lastName?.[0] ?? '')}
                </div>
                <span className="text-[12px] text-slate-700">{a.user?.firstName} {a.user?.lastName}</span>
                {a.role && <span className="text-[10px] text-slate-400">({a.role})</span>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Zone + Phase info */}
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        {task.zone && <div><span className="text-slate-400">Zone:</span> <span className="text-slate-700 font-medium">{task.zone.name}</span></div>}
        {task.phase && <div><span className="text-slate-400">Service:</span> <span className="text-slate-700 font-medium">{task.phase.name}</span></div>}
        {task.serviceType && <div><span className="text-slate-400">Phase/Milestone:</span> <span className="text-slate-700 font-medium">{task.serviceType.name}</span></div>}
      </div>
    </div>
  );
}

function TaskTimeTab({ taskId, taskName }: { taskId: number; taskName: string }) {
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const queryClient = useQueryClient();

  const { data: entries = [] } = useQuery({
    queryKey: ['time-entries', 'task', taskId],
    queryFn: () => client.get('/time-entries', { params: { taskId } }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const logTime = useMutation({
    mutationFn: () => timeApi.createEntry({
      taskId, date: new Date().toISOString().split('T')[0],
      minutes: Math.round(Number(hours) * 60), note: note.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time-entries', 'task', taskId] });
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success(`Logged ${hours}h`, { code: 'TIME-LOG-200' });
      setHours(''); setNote('');
    },
    onError: (err: any) => notify.apiError(err, 'Failed to log time'),
  });

  const totalMinutes = (entries as any[]).reduce((s, e) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* Quick log */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <h4 className="text-[12px] font-semibold text-slate-600">Log Time</h4>
        <div className="flex gap-2">
          <input type="number" step="0.25" min="0.25" value={hours} onChange={(e) => setHours(e.target.value)}
            placeholder="Hours" className="w-20 px-2 py-1.5 rounded border border-slate-200 text-sm focus:border-blue-400 focus:outline-none" />
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Note..." className="flex-1 px-2 py-1.5 rounded border border-slate-200 text-sm focus:border-blue-400 focus:outline-none" />
          <button onClick={() => { if (hours && Number(hours) > 0) logTime.mutate(); }}
            disabled={!hours || logTime.isPending}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            Log
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="text-[12px] text-slate-500">
        Total logged: <span className="font-semibold text-slate-700">{Math.round(totalMinutes / 60 * 10) / 10}h</span>
        {(entries as any[]).length > 0 && <span> ({(entries as any[]).length} entries)</span>}
      </div>

      {/* Entries list */}
      <div className="space-y-1">
        {(entries as any[]).slice(0, 20).map((e: any) => (
          <div key={e.id} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-[12px]">
            <span className="text-slate-500">{e.date ? new Date(e.date).toLocaleDateString() : '-'}</span>
            <span className="font-medium text-slate-700">{Math.round((e.minutes ?? 0) / 60 * 10) / 10}h</span>
            {e.note && <span className="text-slate-400 truncate max-w-[150px]">{e.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskDiscussionTab({ taskId }: { taskId: number }) {
  const [text, setText] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['messages', 'task', taskId],
    queryFn: () => client.get('/messages', { params: { entityType: 'task', entityId: taskId } }).then((r) => r.data),
  });

  const messages = (data as any)?.data ?? [];

  const sendMessage = useMutation({
    mutationFn: (content: string) => client.post('/messages', { entityType: 'task', entityId: taskId, content }).then((r) => r.data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['messages', 'task', taskId] }); setText(''); },
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input type="text" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { sendMessage.mutate(text.trim()); } }}
          placeholder="Type a message..." className="flex-1 px-2 py-1.5 rounded border border-slate-200 text-[12px] focus:border-blue-400 focus:outline-none" />
        <button onClick={() => { if (text.trim()) sendMessage.mutate(text.trim()); }}
          disabled={!text.trim() || sendMessage.isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Send</button>
      </div>

      {isLoading ? <p className="text-[11px] text-slate-400 text-center py-4">Loading...</p> : messages.length === 0 ? (
        <p className="text-[11px] text-slate-400 text-center py-4">No messages yet</p>
      ) : (
        <div className="space-y-2">
          {messages.map((msg: any) => (
            <div key={msg.id} className="text-[12px]">
              {msg.type === 'system' ? (
                <p className="text-[10px] text-slate-400 italic text-center">{msg.content}</p>
              ) : (
                <div className="rounded-md bg-slate-50 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-700">{msg.author?.firstName ?? 'User'}</span>
                    <span className="text-[10px] text-slate-400">{msg.createdAt ? formatRelative(msg.createdAt) : ''}</span>
                  </div>
                  <p className="text-slate-600 mt-0.5">{msg.content}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
