import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { useProject } from '@/hooks/use-projects';
import { useTask } from '@/hooks/use-tasks';

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
  'partner-types': 'Contact & Organization Types',
  'number-ranges': 'Number Ranges',
  'object-numbering': 'Object Numbering',
  currencies: 'Currencies',
  'seniority-levels': 'Labor Categories',
  'project-role-types': 'Project Role Types',
  'data-import': 'Data Import',
  history: 'History',
  'project-stage-milestones': 'Project Stage Milestones',
};

/**
 * BC-2 (QA4 · 2026-10-07) — subscribing id-crumb.
 *
 * The previous `resolveIdLabel` helper read the react-query cache via
 * `qc.getQueryData(['projects', id])` during the Breadcrumbs render.
 * That lookup does NOT subscribe to the cache, so when the detail page
 * (which lives UNDER the layout that renders this breadcrumb) finished
 * loading its `useProject(id)` query, Breadcrumbs never re-rendered and
 * the `#id` fallback stuck forever.
 *
 * This child component subscribes by calling the SAME hook (`useProject`
 * / `useTask`) that the detail page uses. React-query dedupes by query
 * key, so no extra network request is issued — this just hooks into the
 * cache the detail page is already populating. Returns the resolved
 * name as soon as the shared cache entry has data; falls back to
 * `#<id>` while it is still fetching.
 */
function ProjectIdCrumb({ id }: { id: number }) {
  const { data } = useProject(id);
  return <>{data?.name ?? `#${id}`}</>;
}

function TaskIdCrumb({ id }: { id: number }) {
  const { data } = useTask(id);
  return <>{data?.name ?? `#${id}`}</>;
}

function IdCrumbLabel({ parent, id }: { parent: string; id: number }) {
  if (parent === 'projects') return <ProjectIdCrumb id={id} />;
  if (parent === 'tasks') return <TaskIdCrumb id={id} />;
  // Unknown parent — no subscribing hook; fall back to the raw id.
  return <>{`#${id}`}</>;
}

type Crumb =
  | { kind: 'static'; path: string; label: string; isLast: boolean }
  | { kind: 'id'; path: string; parent: string; id: number; isLast: boolean };

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  const crumbs: Crumb[] = segments.map((segment, index) => {
    const path = '/' + segments.slice(0, index + 1).join('/');
    const isLast = index === segments.length - 1;

    // Static label first.
    if (ROUTE_LABELS[segment] != null) {
      return { kind: 'static', path, label: ROUTE_LABELS[segment], isLast };
    }

    // Numeric id — subscribe to the parent entity's detail query so the
    // breadcrumb re-renders when the name becomes available.
    const asNumber = Number(segment);
    if (!Number.isNaN(asNumber) && String(asNumber) === segment) {
      const parent = segments[index - 1] ?? '';
      return { kind: 'id', path, parent, id: asNumber, isLast };
    }

    // Unknown slug — render as-is (fallback for the rare route that
    // slipped past ROUTE_LABELS). Preferable to a `#` when the slug is
    // human-readable, and it flags a missing label in the map to whoever
    // sees the breadcrumb.
    return { kind: 'static', path, label: segment, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link to="/" className="hover:text-foreground" aria-label="Dashboard">
        <Home className="h-4 w-4" aria-hidden="true" />
      </Link>
      {crumbs.map((crumb) => {
        const labelNode =
          crumb.kind === 'id'
            ? <IdCrumbLabel parent={crumb.parent} id={crumb.id} />
            : crumb.label;
        return (
          <span key={crumb.path} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            {crumb.isLast ? (
              <span className="font-medium text-foreground" aria-current="page">{labelNode}</span>
            ) : (
              <Link to={crumb.path} className="hover:text-foreground">
                {labelNode}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
