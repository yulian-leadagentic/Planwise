import { Link } from 'react-router-dom';
import {
  BookOpen,
  Copy,
  Layers,
  ListChecks,
  Tags,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';

const templateCards = [
  {
    title: 'Task Catalog',
    description: 'Standalone task library — all reusable task definitions',
    icon: BookOpen,
    href: '/templates/task-catalog',
    color: 'bg-blue-100 text-blue-700',
  },
  {
    title: 'Service Templates',
    description: 'Groups of tasks from the catalog assigned to a service',
    icon: Copy,
    href: '/templates/service',
    color: 'bg-amber-100 text-amber-700',
  },
  {
    title: 'Zone Templates',
    description: 'Zone hierarchy with services and tasks assigned',
    icon: Layers,
    href: '/templates/zone',
    color: 'bg-green-100 text-green-700',
  },
  {
    title: 'Phases/Milestones',
    description: 'Manage phases: Design, Construction, Handover',
    icon: ListChecks,
    href: '/templates/phases',
    color: 'bg-cyan-100 text-cyan-700',
  },
  {
    title: 'Types',
    description: 'Manage zone types, service types, and project types',
    icon: Tags,
    href: '/templates/types',
    color: 'bg-orange-100 text-orange-700',
  },
  {
    title: 'Team Templates',
    description: 'Reusable team compositions for projects',
    icon: Users,
    href: '/templates/team',
    color: 'bg-rose-100 text-rose-700',
  },
];

export function TemplatesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Templates" description="Manage task catalog, service templates, zone templates, and configurations" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {templateCards.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="rounded-lg border bg-card p-5 hover:shadow-md transition-shadow"
          >
            <div className={`inline-flex p-2 rounded-lg ${card.color} mb-3`}>
              <card.icon className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-sm">{card.title}</h3>
            <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
