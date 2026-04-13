import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Clock, AlertTriangle, AtSign, BarChart3, Users, CheckCircle, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { formatRelative } from '@/lib/date-utils';
import { cn } from '@/lib/utils';

export function MessagingDashboardPage() {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<string>('');

  const { data: analytics, isLoading } = useQuery({
    queryKey: ['messages', 'analytics', projectId],
    queryFn: () => client.get('/messages/analytics/overview', {
      params: projectId ? { projectId } : {},
    }).then((r) => r.data?.data ?? r.data),
  });

  if (isLoading) return <PageSkeleton />;

  const stats = analytics ?? {
    totalMessages: 0, totalThreads: 0, unresolvedThreads: 0,
    mentionCount: 0, avgResponseMinutes: 0, urgentMessages: 0, recentActivity: [],
  };

  const kpiCards = [
    { label: 'Total Messages', value: stats.totalMessages, icon: MessageSquare, color: 'text-blue-600 bg-blue-100' },
    { label: 'Open Threads', value: stats.totalThreads, icon: BarChart3, color: 'text-indigo-600 bg-indigo-100' },
    { label: 'Unresolved', value: stats.unresolvedThreads, icon: AlertTriangle, color: 'text-amber-600 bg-amber-100' },
    { label: 'Mentions', value: stats.mentionCount, icon: AtSign, color: 'text-green-600 bg-green-100' },
    { label: 'Avg Response', value: stats.avgResponseMinutes > 0 ? `${stats.avgResponseMinutes}m` : '-', icon: Clock, color: 'text-cyan-600 bg-cyan-100' },
    { label: 'Urgent Items', value: stats.urgentMessages, icon: AlertTriangle, color: stats.urgentMessages > 0 ? 'text-red-600 bg-red-100' : 'text-slate-500 bg-slate-100' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messaging Dashboard"
        description="Communication analytics, open threads, and engagement KPIs"
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => navigate('/messages/search')}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Search className="h-3.5 w-3.5" /> Search Messages
            </button>
          </div>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-[14px] border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', card.color)}>
                  <Icon className="h-4 w-4" />
                </div>
              </div>
              <p className="text-2xl font-bold text-slate-900">{card.value}</p>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">{card.label}</p>
            </div>
          );
        })}
      </div>

      {/* Recent Activity */}
      <div className="rounded-[14px] border border-slate-200 bg-white">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-[15px] font-bold text-slate-900">Recent Activity</h3>
        </div>
        <div className="divide-y divide-slate-50">
          {(stats.recentActivity ?? []).length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">No recent messages</div>
          ) : (
            (stats.recentActivity as any[]).map((msg: any) => (
              <div key={msg.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0">
                  {msg.author ? `${msg.author.firstName?.[0] ?? ''}${msg.author.lastName?.[0] ?? ''}` : 'S'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-slate-700 truncate">{msg.content}</p>
                  <p className="text-[11px] text-slate-400">
                    {msg.author ? `${msg.author.firstName} ${msg.author.lastName}` : 'System'} · {formatRelative(msg.createdAt)}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                  {msg.entityType}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
