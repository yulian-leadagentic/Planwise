import { useState } from 'react';
import { Plus } from 'lucide-react';
import { USER_TYPES } from '@amec/shared';
import { useUsers } from '@/hooks/use-users';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { UserAvatar } from '@/components/shared/user-avatar';

type Tab = 'all' | 'employee' | 'partner';

export function PeoplePage() {
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const params = activeTab === 'all' ? {} : { userType: activeTab };
  const { data, isLoading } = useUsers(params);
  const users = data?.data || [];

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'employee', label: 'Employees' },
    { key: 'partner', label: 'Partners' },
  ];

  const columns = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }: { row: { original: { firstName: string; lastName: string; avatarUrl?: string | null; email: string } } }) => (
        <div className="flex items-center gap-3">
          <UserAvatar
            firstName={row.original.firstName}
            lastName={row.original.lastName}
            avatarUrl={row.original.avatarUrl || undefined}
            size="sm"
          />
          <div>
            <div className="font-medium">{row.original.firstName} {row.original.lastName}</div>
            <div className="text-xs text-muted-foreground">{row.original.email}</div>
          </div>
        </div>
      ),
    },
    {
      accessorKey: 'userType',
      header: 'Type',
      cell: ({ row }: { row: { original: { userType: string } } }) => (
        <span className="capitalize text-sm">{row.original.userType}</span>
      ),
    },
    {
      accessorKey: 'position',
      header: 'Position',
      cell: ({ row }: { row: { original: { position?: string | null } } }) =>
        row.original.position || '—',
    },
    {
      accessorKey: 'department',
      header: 'Department',
      cell: ({ row }: { row: { original: { department?: string | null } } }) =>
        row.original.department || '—',
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      cell: ({ row }: { row: { original: { isActive: boolean } } }) => (
        <span className={`text-xs font-medium px-2 py-1 rounded-full ${row.original.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Manage employees and partners"
        actions={
          <button className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Add Person
          </button>
        }
      />

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <DataTable columns={columns} data={users} isLoading={isLoading} />
    </div>
  );
}
