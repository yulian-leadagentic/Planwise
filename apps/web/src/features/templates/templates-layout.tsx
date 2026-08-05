import { BookOpen, Copy, Layers, ListChecks, Tags, Users } from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';

/**
 * Flat sub-nav for the Templates section. Six items — no grouping
 * needed. Order matches the Templates hub cards so users find each
 * item in the same visual position across the two surfaces.
 */
const TEMPLATE_ITEMS: SubNavItem[] = [
  { label: 'Task Catalog',           href: '/templates/task-catalog', icon: BookOpen,   module: 'templates/task-catalog' },
  { label: 'Deliverable Templates',  href: '/templates/deliverables', icon: Copy,       module: 'templates/deliverables' },
  { label: 'Zone Templates',         href: '/templates/zone',         icon: Layers,     module: 'templates/zone' },
  { label: 'Services',               href: '/templates/services',     icon: ListChecks, module: 'templates/services' },
  { label: 'Types',                  href: '/templates/types',        icon: Tags,       module: 'templates/types' },
  { label: 'Team Templates',         href: '/templates/team',         icon: Users,      module: 'templates/team' },
];

export function TemplatesLayout() {
  return (
    <SubNavLayout
      title="Templates"
      description="Task catalog, deliverable templates, zones, and reusable configurations"
      items={TEMPLATE_ITEMS}
      homeHref="/templates"
      homeLabel="Overview"
    />
  );
}
