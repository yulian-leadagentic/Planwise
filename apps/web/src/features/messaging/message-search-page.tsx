import { useState } from 'react';
import { Search, MessageSquare, Filter, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { formatRelative } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import client from '@/api/client';

const entityLabels: Record<string, string> = {
  project: 'Project',
  task: 'Task',
  zone: 'Zone',
};

export function MessageSearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['messages', 'search', query, entityTypeFilter, page],
    queryFn: () =>
      client.get('/messages/search/query', {
        params: { q: query, entityType: entityTypeFilter || undefined, page, perPage: 20 },
      }).then((r) => r.data?.data ?? r.data),
    enabled: query.length >= 2,
  });

  const results = (data as any)?.data ?? [];
  const meta = (data as any)?.meta ?? { total: 0, totalPages: 0 };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Search Messages"
        description="Search across all discussions, threads, and mentions"
      />

      {/* Search bar */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search messages, discussions, mentions..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none"
            autoFocus
          />
        </div>
        <select
          value={entityTypeFilter}
          onChange={(e) => { setEntityTypeFilter(e.target.value); setPage(1); }}
          className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700"
        >
          <option value="">All types</option>
          <option value="project">Projects</option>
          <option value="task">Tasks</option>
          <option value="zone">Zones</option>
        </select>
      </div>

      {/* Results */}
      {query.length < 2 ? (
        <div className="py-12 text-center">
          <Search className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-400">Type at least 2 characters to search</p>
        </div>
      ) : isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Searching...</div>
      ) : results.length === 0 ? (
        <div className="py-12 text-center">
          <MessageSquare className="mx-auto h-12 w-12 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No messages found for "{query}"</p>
        </div>
      ) : (
        <>
          <p className="text-[12px] font-medium text-slate-400">
            {meta.total} result{meta.total !== 1 ? 's' : ''} for "{query}"
          </p>
          <div className="space-y-2">
            {results.map((msg: any) => {
              const author = msg.author;
              // Highlight search term
              const highlightContent = (text: string) => {
                if (!query) return text;
                const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                const parts = text.split(regex);
                return parts.map((part: string, i: number) =>
                  regex.test(part) ? (
                    <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">{part}</mark>
                  ) : (
                    <span key={i}>{part}</span>
                  ),
                );
              };

              return (
                <div
                  key={msg.id}
                  className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 cursor-pointer transition-colors"
                  onClick={() => {
                    if (msg.entityType === 'project') navigate(`/projects/${msg.entityId}`);
                    else navigate('/inbox');
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                      {author ? `${author.firstName?.[0] ?? ''}${author.lastName?.[0] ?? ''}` : 'S'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800">
                          {author ? `${author.firstName} ${author.lastName}` : 'System'}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                          {entityLabels[msg.entityType] || msg.entityType}
                        </span>
                        {msg.parent && (
                          <span className="text-[10px] text-slate-400">reply to thread</span>
                        )}
                        <span className="text-[11px] text-slate-400 ml-auto shrink-0">
                          {formatRelative(msg.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] text-slate-600 line-clamp-3">
                        {highlightContent(msg.content)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-300 shrink-0 mt-2" />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {meta.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {meta.totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                disabled={page >= meta.totalPages}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
