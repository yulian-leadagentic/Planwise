import { useState, useRef, useEffect } from 'react';
import { Bell, Check, MessageSquare, UserPlus, AlertCircle, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/use-notifications';
import { formatRelative } from '@/lib/date-utils';
import { cn } from '@/lib/utils';

const typeIcons: Record<string, any> = {
  mention: { icon: MessageSquare, color: 'text-blue-600 bg-blue-100' },
  reply: { icon: MessageSquare, color: 'text-indigo-600 bg-indigo-100' },
  assignment: { icon: UserPlus, color: 'text-green-600 bg-green-100' },
  status_change: { icon: AlertCircle, color: 'text-amber-600 bg-amber-100' },
  message: { icon: MessageSquare, color: 'text-slate-600 bg-slate-100' },
  system: { icon: AlertCircle, color: 'text-slate-500 bg-slate-100' },
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleNotificationClick = (n: any) => {
    if (!n.isRead) markRead(n.id);
    setOpen(false);
    if (n.entityType === 'project' && n.entityId) navigate(`/projects/${n.entityId}`);
    else if (n.entityType === 'task' && n.entityId) navigate(`/projects`);
    else navigate('/inbox');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-96 rounded-[14px] border border-slate-200 bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-bold text-slate-900">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700"
              >
                <Check className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-8 text-center">
                <Bell className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-2 text-sm text-slate-400">No notifications</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-50">
                {notifications.slice(0, 15).map((n) => {
                  const typeInfo = typeIcons[n.type] || typeIcons.system;
                  const Icon = typeInfo.icon;
                  return (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors',
                        !n.isRead && 'bg-blue-50/30',
                      )}
                    >
                      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg mt-0.5', typeInfo.color)}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn('text-[13px] leading-snug', n.isRead ? 'text-slate-600' : 'text-slate-900 font-medium')}>
                          {n.title}
                        </p>
                        {n.body && (
                          <p className="mt-0.5 text-[12px] text-slate-400 line-clamp-2">{n.body}</p>
                        )}
                        <p className="mt-1 text-[11px] text-slate-400">{formatRelative(n.createdAt)}</p>
                      </div>
                      {!n.isRead && (
                        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-100 px-4 py-2.5">
            <button
              onClick={() => { setOpen(false); navigate('/inbox'); }}
              className="flex w-full items-center justify-center gap-1 text-[12px] font-semibold text-blue-600 hover:text-blue-700"
            >
              View all in Inbox <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
