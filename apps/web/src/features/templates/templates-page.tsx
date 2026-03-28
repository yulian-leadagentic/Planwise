import { useState } from 'react';
import { Plus, Copy, Users } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';

type Tab = 'project' | 'team';

export function TemplatesPage() {
  const [activeTab, setActiveTab] = useState<Tab>('project');

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'project', label: 'Project Templates', icon: <Copy className="h-4 w-4" /> },
    { key: 'team', label: 'Team Templates', icon: <Users className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description="Create reusable project and team templates"
        actions={
          <button className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" />
            New Template
          </button>
        }
      />

      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'project' && (
        <EmptyState
          icon={Copy}
          title="No project templates"
          description="Create a project template to quickly scaffold new projects with predefined labels and tasks."
          action={
            <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Create Template
            </button>
          }
        />
      )}

      {activeTab === 'team' && (
        <EmptyState
          icon={Users}
          title="No team templates"
          description="Create a team template to quickly assign the same group of people to new projects."
          action={
            <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Create Template
            </button>
          }
        />
      )}
    </div>
  );
}
