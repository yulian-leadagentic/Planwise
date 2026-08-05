import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/date-utils';

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-blue-100 text-blue-700',
  warn: 'bg-amber-100 text-amber-700',
  error: 'bg-red-100 text-red-700',
  critical: 'bg-red-200 text-red-800',
};

export function ActivityLogPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'activity-logs', page],
    queryFn: () => client.get('/admin/activity-logs', { params: { page, perPage: 20 } }).then((r) => r.data),
  });

  const logs = data?.data ?? [];
  const meta = data?.meta;

  // Columns for the shared DataTable. Sorting disabled — the server
  // returns rows in reverse-chronological order and pagination is
  // server-side (see server-pager below).
  const columns = useMemo<ColumnDef<any, unknown>[]>(() => [
    { id: 'time', header: 'Time', enableSorting: false,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {formatDateTime(row.original.createdAt)}
        </span>
      ) },
    { id: 'user', header: 'User', enableSorting: false,
      cell: ({ row }) => row.original.user
        ? `${row.original.user.firstName} ${row.original.user.lastName}`
        : 'System' },
    { accessorKey: 'action', header: 'Action', enableSorting: false,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
    { accessorKey: 'severity', header: 'Severity', enableSorting: false, size: 96,
      cell: ({ row }) => (
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', SEVERITY_STYLES[row.original.severity] ?? 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200')}>
          {row.original.severity}
        </span>
      ) },
    { id: 'entity', header: 'Entity', enableSorting: false,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.entityType ? `${row.original.entityType} #${row.original.entityId}` : '—'}
        </span>
      ) },
    { accessorKey: 'description', header: 'Description', enableSorting: false,
      cell: ({ row }) => <span className="block max-w-xs truncate">{row.original.description}</span> },
  ], []);

  return (
    <div className="space-y-6">
      <PageHeader title="Activity Log" description="View system-wide audit trail" />

      {isLoading ? (
        <TableSkeleton rows={10} cols={6} />
      ) : logs.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No activity logs yet"
          description="Actions across the app will appear here as they happen."
        />
      ) : (
        <>
          {/* pageSize very high — server-side pagination controls
              (below) drive what data is loaded; DataTable's own
              pager is suppressed. */}
          <DataTable columns={columns} data={logs} pageSize={1000} />

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                aria-label="Previous page"
                className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page{' '}
                <span className="font-mono tabular-nums">{page}</span>
                {' '}of{' '}
                <span className="font-mono tabular-nums">{meta.totalPages}</span>
              </span>
              <button
                disabled={page >= meta.totalPages}
                onClick={() => setPage(page + 1)}
                aria-label="Next page"
                className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
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
