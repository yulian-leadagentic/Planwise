import { useQuery } from '@tanstack/react-query';
import {
  Activity, MessageSquare, UserPlus, CheckCircle, AlertCircle, Clock, FolderPlus,
  Edit3, Trash2, FileText, Paperclip, Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/date-utils';
import client from '@/api/client';

/**
 * Project Activity Feed.
 *
 * Pulls three independent streams and merges by date:
 *   1. /projects/:id/activity-logs — system-audited writes (creates,
 *      updates, status changes, assignee adds, file events). New source
 *      as of 2026-06-22 — populated by ActivityLogService on the API.
 *   2. /messages?entityType=project — the project's discussion thread.
 *   3. /notifications — alerts directed at the current user about this
 *      project (mentions, overdue, etc.).
 *
 * Each source has its own shape; we normalize into a single "feed item"
 * before rendering so the timeline reads as one chronological story.
 */
type FeedItem = {
  id: string;
  category: string;
  title: string;
  body?: string | null;
  actorName?: string | null;
  actorAvatarUrl?: string | null;
  createdAt: string;
};

const ICON_CONFIG: Record<string, { icon: any; color: string }> = {
  'project:create':         { icon: FolderPlus,  color: 'text-emerald-600 bg-emerald-100' },
  'project:update':         { icon: Edit3,       color: 'text-blue-600 bg-blue-100' },
  'project:delete':         { icon: Trash2,      color: 'text-red-600 bg-red-100' },
  'project:member_add':     { icon: UserPlus,    color: 'text-green-600 bg-green-100' },
  'project:member_remove':  { icon: UserPlus,    color: 'text-amber-600 bg-amber-100' },
  'project:role_assign':    { icon: Briefcase,   color: 'text-indigo-600 bg-indigo-100' },
  'project:role_end':       { icon: Briefcase,   color: 'text-slate-500 bg-slate-100' },
  'project:file_add':       { icon: Paperclip,   color: 'text-cyan-600 bg-cyan-100' },
  'project:file_remove':    { icon: Paperclip,   color: 'text-rose-500 bg-rose-100' },
  'task:create':            { icon: FileText,    color: 'text-blue-600 bg-blue-100' },
  'task:update':            { icon: Edit3,       color: 'text-blue-500 bg-blue-100' },
  'task:status_change':     { icon: CheckCircle, color: 'text-amber-600 bg-amber-100' },
  'task:delete':            { icon: Trash2,      color: 'text-red-600 bg-red-100' },
  'task:assignee_add':      { icon: UserPlus,    color: 'text-green-600 bg-green-100' },
  'task:assignee_remove':   { icon: UserPlus,    color: 'text-amber-600 bg-amber-100' },
  'task:attachment_add':    { icon: Paperclip,   color: 'text-cyan-600 bg-cyan-100' },
  'task:attachment_remove': { icon: Paperclip,   color: 'text-rose-500 bg-rose-100' },
  'time:create':            { icon: Clock,       color: 'text-violet-600 bg-violet-100' },
  'time:delete':            { icon: Clock,       color: 'text-rose-500 bg-rose-100' },
  'message':                { icon: MessageSquare, color: 'text-slate-600 bg-slate-100' },
  'mention':                { icon: MessageSquare, color: 'text-blue-600 bg-blue-100' },
  'system':                 { icon: AlertCircle,   color: 'text-slate-500 bg-slate-100' },
};

function configFor(key: string) {
  return ICON_CONFIG[key] || ICON_CONFIG[key.split(':')[0]] || ICON_CONFIG['system'];
}

export function ActivityFeed({ projectId }: { projectId: number }) {
  const { data: items = [], isLoading, isError, refetch } = useQuery<FeedItem[]>({
    queryKey: ['activity', 'project', projectId],
    queryFn: async () => {
      const [logsResult, msgResult, notifResult] = await Promise.all([
        client.get(`/projects/${projectId}/activity-logs`, { params: { perPage: 100 } })
          .then((r) => {
            const d = r.data?.data ?? r.data;
            return Array.isArray(d) ? d : d?.data ?? [];
          }),
        client.get('/messages', { params: { entityType: 'project', entityId: projectId, perPage: 30 } })
          .then((r) => {
            const d = r.data?.data ?? r.data;
            return Array.isArray(d) ? d : d?.data ?? [];
          }),
        client.get('/notifications', { params: { perPage: 50 } })
          .then((r) => {
            const d = r.data?.data ?? r.data;
            return Array.isArray(d) ? d : d?.data ?? [];
          }),
      ]);

      const logs: FeedItem[] = (logsResult as any[]).map((l: any) => ({
        id: `log-${l.id}`,
        category: `${l.category}:${l.action}`,
        title: l.description,
        body: null,
        actorName: l.user ? `${l.user.firstName ?? ''} ${l.user.lastName ?? ''}`.trim() || null : null,
        actorAvatarUrl: l.user?.avatarUrl ?? null,
        createdAt: l.createdAt,
      }));

      const msgs: FeedItem[] = (msgResult as any[]).map((m: any) => ({
        id: `msg-${m.id}`,
        category: m.type === 'system' ? 'system' : 'message',
        title: m.type === 'system' ? m.content : `${m.author?.firstName ?? 'User'} commented`,
        body: m.type === 'system' ? null : m.content,
        actorName: m.author ? `${m.author.firstName ?? ''} ${m.author.lastName ?? ''}`.trim() : null,
        actorAvatarUrl: m.author?.avatarUrl ?? null,
        createdAt: m.createdAt,
      }));

      const notifs: FeedItem[] = (notifResult as any[])
        .filter((n: any) => n.entityType === 'project' && n.entityId === projectId)
        .map((n: any) => ({
          id: `notif-${n.id}`,
          category: n.type ?? 'system',
          title: n.title,
          body: n.body ?? null,
          actorName: n.actor ? `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim() : null,
          actorAvatarUrl: n.actor?.avatarUrl ?? null,
          createdAt: n.createdAt,
        }));

      return [...logs, ...msgs, ...notifs]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 200);
    },
    staleTime: 30 * 1000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-blue-600" />
        <h3 className="text-sm font-semibold text-slate-700">Activity Feed</h3>
        {items.length > 0 && (
          <span className="text-[11px] text-slate-400">· {items.length} {items.length === 1 ? 'entry' : 'entries'}</span>
        )}
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-sm text-slate-400">Loading activity...</div>
      ) : isError ? (
        <div className="py-8 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-2 text-sm text-slate-400">Couldn't load activity.</p>
          <button onClick={() => refetch()} className="mt-1 text-[12px] font-medium text-blue-600 hover:underline">Retry</button>
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center">
          <Activity className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-2 text-sm text-slate-400">No activity yet</p>
          <p className="mt-1 text-[11px] text-slate-400">Changes to this project will appear here automatically.</p>
        </div>
      ) : (
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0 w-px bg-slate-200" />

          <div className="space-y-0">
            {items.map((item) => {
              const cfg = configFor(item.category);
              const Icon = cfg.icon;
              return (
                <div key={item.id} className="relative flex gap-3 py-2.5 pl-1">
                  <div className={cn('relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', cfg.color)}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <p className="text-[13px] text-slate-700">{item.title}</p>
                    {item.body && (
                      <p className="mt-0.5 text-[12px] text-slate-500 line-clamp-2">{item.body}</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {formatRelative(item.createdAt)}
                      {item.actorName && ` · ${item.actorName}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
