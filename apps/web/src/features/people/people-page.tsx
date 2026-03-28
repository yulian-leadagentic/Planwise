import { Plus, Users } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { FilterBar } from '@/components/shared/filter-bar';
import { DataTable } from '@/components/shared/data-table';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';
import { useUsers } from '@/hooks/use-users';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import type { UserListItem } from '@/types';
import type { ColumnDef } from '@tanstack/react-table';

const columns: ColumnDef<UserListItem, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <UserAvatar
          firstName={row.original.firstName}
          lastName={row.original.lastName}
          avatarUrl={row.original.avatarUrl}
          size="sm"
        />
        <div>
          <p className="font-medium">
            {row.original.firstName} {row.original.lastName}
          </p>
        </div>
      </div>
    ),
  },
  {
    accessorKey: 'userType',
    header: 'Type',
    cell: ({ row }) => (
      <span className="text-sm capitalize">{row.original.userType}</span>
    ),
  },
  {
    accessorKey: 'position',
    header: 'Position',
    cell: ({ row }) => row.original.position ?? '-',
  },
  {
    accessorKey: 'department',
    header: 'Department',
    cell: ({ row }) => row.original.department ?? '-',
  },
  {
    accessorKey: 'companyName',
    header: 'Company',
    cell: ({ row }) => row.original.companyName ?? '-',
  },
  {
    accessorKey: 'roleName',
    header: 'Role',
    cell: ({ row }) => row.original.roleName,
  },
  {
    accessorKey: 'isActive',
    header: 'Status',
    cell: ({ row }) => (
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          row.original.isActive
            ? 'bg-green-100 text-green-700'
            : 'bg-gray-100 text-gray-500',
        )}
      >
        {row.original.isActive ? 'Active' : 'Inactive'}
      </span>
    ),
  },
];

export function PeoplePage() {
  const { peopleTab, peopleSearch, setPeopleFilters } = useFilterStore();
  const debouncedSearch = useDebounce(peopleSearch, 300);

  const userType = peopleTab === 'employees' ? 'employee' : 'partner';
  const { data, isLoading } = useUsers({
    userType,
    search: debouncedSearch || undefined,
  });

  const users = data?.data ?? [];

  const tabs = [
    { key: 'employees' as const, label: 'Employees' },
    { key: 'partners' as const, label: 'Partners' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Manage employees and partners"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" />
            Add Person
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setPeopleFilters({ peopleTab: tab.key })}
            className={cn(
              'border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              peopleTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <FilterBar
        search={peopleSearch}
        onSearchChange={(v) => setPeopleFilters({ peopleSearch: v })}
        searchPlaceholder={`Search ${peopleTab}...`}
      />

      {!isLoading && users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={`No ${peopleTab} found`}
          description={`Add your first ${peopleTab === 'employees' ? 'employee' : 'partner'} to get started`}
        />
      ) : (
        <DataTable
          columns={columns}
          data={users}
          isLoading={isLoading}
          renderCard={(user) => (
            <div className="rounded-lg border border-border bg-background p-4 hover:bg-muted/50">
              <div className="flex items-center gap-3">
                <UserAvatar
                  firstName={user.firstName}
                  lastName={user.lastName}
                  avatarUrl={user.avatarUrl}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {user.position ?? user.companyName ?? user.roleName}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    user.isActive
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500',
                  )}
                >
                  {user.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          )}
          emptyMessage="No users found"
        />
      )}
    </div>
  );
}
