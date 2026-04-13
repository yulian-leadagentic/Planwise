import { useState } from 'react';
import { MessageSquare, AtSign, Reply, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { useInbox } from '@/hooks/use-messages';
import { formatRelative } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/shared/loading-skeleton';

function getInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
}

const entityLabels: Record<string, string> = {
  project: 'Project',
  task: 'Task',
  zone: 'Zone',
};

export function InboxPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'mentions' | 'replies'>('all');
  const { data, isLoading } = useInbox();

  const allMessages = (data as any)?.data ?? [];

  const filtered = allMessages.filter((msg: any) => {
    if (tab === 'mentions') return msg.mentions?.length > 0;
    if (tab === 'replies') return (msg._count?.replies ?? 0) > 0;
    return true;
  });

  const getEntityLink = (msg: any): string => {
    if (msg.entityType === 'project') return `/projects/${msg.entityId}`;
    if (msg.entityType === 'task') return `/projects`; // task detail if exists
    return '#';
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbox"
        description="Messages, mentions, and replies across all your projects"
      />

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
        {([
          { key: 'all', label: 'All' },
          { key: 'mentions', label: 'Mentions' },
          { key: 'replies', label: 'Replies' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors',
              tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <PageSkeleton />
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <MessageSquare className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-700">No messages</p>
          <p className="mt-1 text-sm text-slate-400">
            {tab === 'mentions' ? "You haven't been mentioned yet." : 'Your inbox is empty.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((msg: any) => {
            const author = msg.author;
            const hasMentions = msg.mentions?.length > 0;
            const replyCount = msg._count?.replies ?? msg.replies?.length ?? 0;

            return (
              <div
                key={msg.id}
                className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:bg-blue-50/20 cursor-pointer transition-colors"
                onClick={() => navigate(getEntityLink(msg))}
              >
                <div className="flex items-start gap-3">
                  {/* Author avatar */}
                  <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-semibold flex items-center justify-center shrink-0">
                    {author ? getInitials(author.firstName, author.lastName) : '?'}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-800">
                        {author ? `${author.firstName} ${author.lastName}` : 'System'}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                        {entityLabels[msg.entityType] || msg.entityType}
                      </span>
                      {hasMentions && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 font-medium">
                          <AtSign className="h-2.5 w-2.5" /> mentioned you
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400 ml-auto shrink-0">
                        {formatRelative(msg.createdAt)}
                      </span>
                    </div>

                    {/* Content preview */}
                    <p className="mt-1 text-[13px] text-slate-600 line-clamp-2">{msg.content}</p>

                    {/* Reply count */}
                    {replyCount > 0 && (
                      <div className="mt-1.5 flex items-center gap-1 text-[11px] text-blue-600">
                        <Reply className="h-3 w-3" />
                        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                      </div>
                    )}
                  </div>

                  <ChevronRight className="h-4 w-4 text-slate-300 shrink-0 mt-2" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
