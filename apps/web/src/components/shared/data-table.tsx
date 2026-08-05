import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type Table,
} from '@tanstack/react-table';
import { useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-media-query';
import { useStickyHScroll } from './sticky-h-scroll';
import { cn } from '@/lib/utils';

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  pageSize?: number;
  renderCard?: (row: TData) => React.ReactNode;
  onRowClick?: (row: TData) => void;
  isLoading?: boolean;
  emptyMessage?: string;
}

export function DataTable<TData>({
  columns,
  data,
  pageSize = 20,
  renderCard,
  onRowClick,
  isLoading,
  emptyMessage = 'No data found',
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const isMobile = useIsMobile();
  // Sticky horizontal scrollbar — pins a proxy bar to the viewport
  // bottom when the table overflows horizontally. Wires once here so
  // every consumer (People, Tasks, Contracts, and any future caller)
  // gets the affordance without re-implementing it. The hook is a no-op
  // when content fits.
  const scrollRef = useStickyHScroll();

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  // Mobile card layout
  if (isMobile && renderCard) {
    return (
      <div className="space-y-3">
        {table.getRowModel().rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <>
            {table.getRowModel().rows.map((row) => (
              <div
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(onRowClick && 'cursor-pointer')}
              >
                {renderCard(row.original)}
              </div>
            ))}
            <Pagination table={table} />
          </>
        )}
      </div>
    );
  }

  // Desktop table layout
  return (
    <div className="space-y-4">
      <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const ariaSort: React.AriaAttributes['aria-sort'] =
                    !canSort ? undefined
                    : sorted === 'asc' ? 'ascending'
                    : sorted === 'desc' ? 'descending'
                    : 'none';
                  return (
                    <th
                      key={header.id}
                      aria-sort={ariaSort}
                      className={cn(
                        'px-4 py-3 text-left font-medium text-muted-foreground',
                        canSort && 'cursor-pointer select-none hover:text-foreground',
                      )}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          aria-label={`Sort by ${typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : header.id}${sorted === 'asc' ? ' — currently ascending' : sorted === 'desc' ? ' — currently descending' : ''}`}
                          className="flex items-center gap-1 -m-1 p-1"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="ml-1" aria-hidden="true">
                            {sorted === 'asc' ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : sorted === 'desc' ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                            )}
                          </span>
                        </button>
                      ) : (
                        <div className="flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border">
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    'hover:bg-muted/50 transition-colors',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination table={table} />
    </div>
  );
}

// Generic over TData so callers passing a strongly-typed Table<Row>
// don't collide with the default Table<unknown>. Without the generic
// `ReturnType<typeof useReactTable>` resolved to Table<unknown>, and
// TanStack's Table<T> is invariant on T so Table<TData> wasn't
// assignable — that's the TS2322 pair on lines 82 + 156 above.
function Pagination<TData>({ table }: { table: Table<TData> }) {
  if (table.getPageCount() <= 1) return null;

  return (
    <div className="flex items-center justify-between px-2">
      <span className="text-sm text-muted-foreground">
        Page{' '}
        <span className="font-mono tabular-nums">{table.getState().pagination.pageIndex + 1}</span>
        {' '}of{' '}
        <span className="font-mono tabular-nums">{table.getPageCount()}</span>
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          aria-label="Previous page"
          className="rounded-md border border-border p-2 text-sm disabled:opacity-50 hover:bg-accent"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          aria-label="Next page"
          className="rounded-md border border-border p-2 text-sm disabled:opacity-50 hover:bg-accent"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
