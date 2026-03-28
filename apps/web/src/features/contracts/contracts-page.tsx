import { useState } from 'react';
import { Plus } from 'lucide-react';
import { CONTRACT_STATUSES } from '@amec/shared';
import { useContracts } from '@/hooks/use-contracts';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { FilterBar } from '@/components/shared/filter-bar';
import { formatCurrency } from '@amec/shared';

export function ContractsPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { data, isLoading } = useContracts(filters);
  const contracts = data?.data || [];

  const columns = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }: { row: { original: { name: string } } }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      accessorKey: 'partner',
      header: 'Partner',
      cell: ({ row }: { row: { original: { partner?: { firstName: string; lastName: string; companyName?: string | null } } } }) =>
        row.original.partner
          ? `${row.original.partner.firstName} ${row.original.partner.lastName}${row.original.partner.companyName ? ` (${row.original.partner.companyName})` : ''}`
          : '—',
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }: { row: { original: { status: string } } }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'totalAmount',
      header: 'Amount',
      cell: ({ row }: { row: { original: { totalAmount?: number | null } } }) =>
        row.original.totalAmount ? formatCurrency(Number(row.original.totalAmount)) : '—',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contracts"
        description="Manage contracts and billing"
        actions={
          <button className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700">
            <Plus className="h-4 w-4" /> New Contract
          </button>
        }
      />

      <FilterBar
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: CONTRACT_STATUSES.map((s) => ({
              value: s,
              label: s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
            })),
          },
        ]}
        values={filters}
        onChange={setFilters}
      />

      <DataTable columns={columns} data={contracts} isLoading={isLoading} />
    </div>
  );
}
