import { Plus, FileText } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { useContracts } from '@/hooks/use-contracts';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { formatDate } from '@/lib/date-utils';
import { formatCurrency } from '@/lib/utils';
import type { Contract } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

const columns: ColumnDef<Contract, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Contract',
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'partner',
    header: 'Partner',
    cell: ({ row }) => {
      const p = row.original.partner;
      if (!p) return '-';
      return (
        <div>
          <p className="text-sm">
            {p.firstName} {p.lastName}
          </p>
          {p.companyName && (
            <p className="text-xs text-muted-foreground">{p.companyName}</p>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'project',
    header: 'Project',
    cell: ({ row }) => row.original.project?.name ?? '-',
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: 'totalAmount',
    header: 'Amount',
    cell: ({ row }) =>
      row.original.totalAmount != null ? formatCurrency(row.original.totalAmount) : '-',
  },
  {
    accessorKey: 'startDate',
    header: 'Period',
    cell: ({ row }) => {
      const start = row.original.startDate;
      const end = row.original.endDate;
      if (!start && !end) return '-';
      return `${start ? formatDate(start) : '...'} - ${end ? formatDate(end) : '...'}`;
    },
  },
];

export function ContractsPage() {
  const { contractSearch, contractStatus, setContractFilters } = useFilterStore();
  const debouncedSearch = useDebounce(contractSearch, 300);

  const { data, isLoading } = useContracts({
    search: debouncedSearch || undefined,
    status: contractStatus.length ? contractStatus[0] : undefined,
  });

  const contracts = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contracts"
        description="Manage contracts and billing"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" />
            New Contract
          </button>
        }
      />

      <FilterBar
        search={contractSearch}
        onSearchChange={(v) => setContractFilters({ contractSearch: v })}
        searchPlaceholder="Search contracts..."
        filters={[
          {
            key: 'status',
            label: 'Status',
            value: contractStatus,
            onChange: (v) => setContractFilters({ contractStatus: v as string[] }),
            multiple: true,
            options: [
              { label: 'Draft', value: 'draft' },
              { label: 'Active', value: 'active' },
              { label: 'Completed', value: 'completed' },
              { label: 'Cancelled', value: 'cancelled' },
            ],
          },
        ]}
        onReset={() => setContractFilters({ contractSearch: '', contractStatus: [] })}
      />

      {!isLoading && contracts.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No contracts yet"
          description="Create your first contract to manage billing and partnerships"
          action={
            <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Create Contract
            </button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={contracts}
          isLoading={isLoading}
          renderCard={(contract) => (
            <div className="rounded-lg border border-border bg-background p-4 hover:bg-muted/50">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium">{contract.name}</h3>
                  {contract.partner && (
                    <p className="text-xs text-muted-foreground">
                      {contract.partner.firstName} {contract.partner.lastName}
                    </p>
                  )}
                </div>
                <StatusBadge status={contract.status} />
              </div>
              {contract.totalAmount != null && (
                <p className="mt-2 text-sm font-medium">{formatCurrency(contract.totalAmount)}</p>
              )}
            </div>
          )}
          emptyMessage="No contracts found"
        />
      )}
    </div>
  );
}
