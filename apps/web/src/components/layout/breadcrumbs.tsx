import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

/**
 * Static slug → display-name map. Every path segment that isn't a
 * dynamic id needs an entry here — otherwise the breadcrumb renders
 * the raw slug (execution-board, my-tasks, etc.) which reads badly.
 *
 * Additions in ux/breadcrumbs-dash: every route slug that was still
 * showing up raw — the admin sub-paths, the templates sub-paths, the
 * dashboard variants, the messaging sub-paths, the report sub-paths,
 * plus 'workload', 'status-board', 'execution-board', 'my-tasks'.
 */
const ROUTE_LABELS: Record<string, string> = {
  '': 'Dashboard',
  // Top-level surfaces
  tasks: 'Tasks',
  'my-tasks': 'My Tasks',
  inbox: 'Inbox',
  time: 'Time',
  projects: 'Projects',
  contracts: 'Contracts',
  partners: 'Organizations',
  contacts: 'Contacts',
  operations: 'Operations',
  reports: 'Reports',
  templates: 'Templates',
  admin: 'Admin',
  people: 'Employees',
  profile: 'Profile',
  'execution-board': 'Execution Board',
  'status-board': 'Status Board',

  // Nested paths — dashboard variants
  dashboard: 'Dashboard',
  manager: 'Manager',
  workload: 'Workload',

  // Time sub-paths
  grid: 'Weekly Grid',
  summary: 'Summary',
  'clock-dashboard': 'Team Clock',

  // Messaging sub-paths
  messages: 'Messages',
  search: 'Search',

  // Project sub-paths
  new: 'New',
  edit: 'Edit',
  planning: 'Planning',

  // Report sub-paths
  timesheet: 'Timesheet',
  attendance: 'Attendance',
  cost: 'Cost',
  overtime: 'Overtime',
  'late-arrivals': 'Late Arrivals',
  milestones: 'Milestones',
  'billing-forecast': 'Billing Forecast',

  // Templates sub-paths
  'task-catalog': 'Task Catalog',
  deliverables: 'Deliverable Templates',
  zone: 'Zone Templates',
  team: 'Team Templates',
  services: 'Services',
  types: 'Types',
  'project-types': 'Project Types',

  // Admin sub-paths
  employees: 'Employees',
  roles: 'Roles & Permissions',
  'activity-log': 'Activity Log',
  'work-schedules': 'Work Schedules',
  calendar: 'Calendar Days',
  'notification-settings': 'Notification Settings',
  'time-note-phrases': 'Time-log Phrases',
  'partner-types': 'Partner Types',
  'number-ranges': 'Number Ranges',
  'object-numbering': 'Object Numbering',
  currencies: 'Currencies',
  'seniority-levels': 'Seniority Levels',
  'project-role-types': 'Project Role Types',
  'data-import': 'Data Import',
  history: 'History',
  'project-stage-milestones': 'Project Stage Milestones',
};

/**
 * Cache-first resolver for numeric id segments. Reads the entity name
 * out of the react-query cache when its detail query is already loaded
 * (usually true — the drawer/detail page pre-fetches on open). Never
 * makes a new request; falls back to `#123` otherwise so the breadcrumb
 * never blocks the page or triggers a spinner.
 *
 * `parentSegment` disambiguates which cache to read from — `/projects/42`
 * looks up `queryKeys.projects.detail(42)` while `/tasks/42` looks up
 * `queryKeys.tasks.detail(42)`. Anything unrecognised falls through to
 * the id-only default.
 */
function resolveIdLabel(qc: ReturnType<typeof useQueryClient>, parentSegment: string, id: number): string {
  if (parentSegment === 'projects') {
    const cached = qc.getQueryData<{ name?: string; displayName?: string }>(queryKeys.projects.detail(id));
    const name = cached?.name ?? cached?.displayName;
    if (name) return name;
  } else if (parentSegment === 'tasks') {
    const cached = qc.getQueryData<{ name?: string; code?: string }>(queryKeys.tasks.detail(id));
    const name = cached?.name ?? cached?.code;
    if (name) return name;
  }
  return `#${id}`;
}

export function Breadcrumbs() {
  const location = useLocation();
  const qc = useQueryClient();
  const segments = location.pathname.split('/').filter(Boolean);

  const crumbs = segments.map((segment, index) => {
    const path = '/' + segments.slice(0, index + 1).join('/');
    const isLast = index === segments.length - 1;

    // Static label first.
    if (ROUTE_LABELS[segment] != null) {
      return { path, label: ROUTE_LABELS[segment], isLast };
    }

    // Numeric id — look up a friendly name from the cache. The parent
    // segment tells us WHICH cache to consult.
    const asNumber = Number(segment);
    if (!Number.isNaN(asNumber) && String(asNumber) === segment) {
      const parent = segments[index - 1] ?? '';
      return { path, label: resolveIdLabel(qc, parent, asNumber), isLast };
    }

    // Unknown slug — render as-is (fallback for the rare route that
    // slipped past ROUTE_LABELS. Preferable to a `#` when the slug is
    // human-readable, and it flags a missing label in the map to whoever
    // sees the breadcrumb).
    return { path, label: segment, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link to="/" className="hover:text-foreground" aria-label="Dashboard">
        <Home className="h-4 w-4" aria-hidden="true" />
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          {crumb.isLast ? (
            <span className="font-medium text-foreground" aria-current="page">{crumb.label}</span>
          ) : (
            <Link to={crumb.path} className="hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
