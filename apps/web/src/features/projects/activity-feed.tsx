import { useQuery } from '@tanstack/react-query';
import { Activity, MessageSquare, UserPlus, CheckCircle, AlertCircle, Clock, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/date-utils';
import client from '@/api/client';

const typeConfig: Record<string, { icon: any; color: string; label: string }> = {
  mention: { icon: MessageSquare, color: 'text-blue-600 bg-blue-100', label: 'Mentioned' },
  reply: { icon: MessageSquare, color: 'text-indigo-600 bg-indigo-100', label: 'Replied' },
  assignment: { icon: UserPlus, color: 'text-green-600 bg-green-100', label: 'Assigned' },
  status_change: { icon: CheckCircle, color: 'text-amber-600 bg-amber-100', label: 'Status Change' },
  message: { icon: MessageSquare, color: 'text-slate-600 bg-slate-100', label: 'Message' },
  system: { icon: AlertCircle, color: 'text-slate-500 bg-slate-100', label: 'System' },
  'alert:overdue': { icon: Clock, color: 'text-red-600 bg-red-100', label: 'Overdue' },
  'alert:missing_time': { icon: Clock, color: 'text-amber-600 bg-amber-100', label: 'Missing Time' },
};

export function ActivityFeed({ projectId }: { projectId: number }) {
  // Fetch notifications related to this project
  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ['activity', 'project', projectId],
    queryFn: async () => {
      const [notifResult, msgResult] = await Promise.all([
        client.get('/notifications', { params: { perPage: 50 } }).then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : d?.data ?? [];
        }),
        client.get('/messages', { params: { entityType: 'project', entityId: projectId, perPage: 30 } }).then((r) => {
          const d = r.data?.data ?? r.data;
          return Array.isArray(d) ? d : d?.data ?? [];
        }),
      ]);

      // Merge and sort by date
      const projectNotifs = (notifResult as any[])
        .filter((n: any) => n.entityType === 'project' && n.entityId === projectId)
        .map((n: any) => ({ ...n, _type: 'notification', _date: n.createdAt }));

      const msgs = (msgResult as any[])
        .map((m: any) => ({
          id: `msg-${m.id}`,
          type: m.type === 'system' ? 'system' : 'message',
          title: m.type === 'system' ? m.content : `${m.author?.firstName ?? 'User'} commented`,
          body: m.type === 'system' ? null : m.content,
          actor: m.author,
          _type: 'message',
          _date: m.createdAt,
          createdAt: m.createdAt,
        }));

      return [...projectNotifs, ...msgs].sort((a, b) =>
        new Date(b._date).getTime() - new Date(a._date).getTime()
      ).slice(0, 50);
    },
    staleTime: 30 * 1000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-blue-600" />
        <h3 className="text-sm font-semibold text-slate-700">Activity Feed</h3>
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-sm text-slate-400">Loading activity...</div>
      ) : (notifications as any[]).length === 0 ? (
        <div className="py-8 text-center">
          <Activity className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-2 text-sm text-slate-400">No activity yet</p>
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-slate-200" />

          <div className="space-y-0">
            {(notifications as any[]).map((item: any, idx: number) => {
              const cfg = typeConfig[item.type] || typeConfig.system;
              const Icon = cfg.icon;

              return (
                <div key={item.id ?? idx} className="relative flex gap-3 py-2.5 pl-1">
                  <div className={cn('relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', cfg.color)}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <p className="text-[13px] text-slate-700">{item.title}</p>
                    {item.body && (
                      <p className="mt-0.5 text-[12px] text-slate-500 line-clamp-2">{item.body}</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {item.createdAt ? formatRelative(item.createdAt) : ''}
                      {item.actor && ` · ${item.actor.firstName} ${item.actor.lastName}`}
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
