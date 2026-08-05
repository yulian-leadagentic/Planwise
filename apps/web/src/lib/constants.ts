import {
  LayoutDashboard,
  Clock,
  FolderKanban,
  FileText,
  Briefcase,
  BarChart3,
  Layers,
  Settings,
  MessageSquare,
  CheckSquare,
  Activity,
  Grid3X3,
  ListChecks,
  UserCircle2,
  type LucideIcon,
} from 'lucide-react';

export const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  on_hold: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
  not_started: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-purple-100 text-purple-700',
  sent: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  paid: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};

export const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  critical: 'bg-red-100 text-red-700',
};

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles?: string[];
  children?: { label: string; href: string }[];
}

/**
 * Sidebar sections. Grouping the ~13 top-level destinations into 5
 * meaningful buckets makes the sidebar easier to scan and gives an
 * obvious home for each domain.
 *
 * A section's header is hidden when its items list is empty (after
 * permission filtering) so a user with no access to any Setup page
 * won't see a phantom "Setup" divider. Same rule applies to the
 * collapsed sidebar — but there the header is hidden regardless
 * (icons don't need a category label; the space is at a premium).
 *
 * Order is deliberate: Work (daily) → Planning (execution) → People
 * → Insights (read-only) → Setup (config). The 4-item mobile nav
 * still picks the top 4 destinations from the flat NAV_ITEMS alias
 * below (see mobile-nav.tsx).
 */
export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Work',
    items: [
      { label: 'Dashboard', href: '/', icon: LayoutDashboard },
      { label: 'My Tasks', href: '/my-tasks', icon: CheckSquare },
      { label: 'Inbox', href: '/inbox', icon: MessageSquare },
      { label: 'Time', href: '/time', icon: Clock },
    ],
  },
  {
    title: 'Planning',
    items: [
      { label: 'Projects', href: '/projects', icon: FolderKanban },
      // Standalone Status Board entry removed (V8). The "Status Board
      // (Project × Deliverable)" view now lives as a tab INSIDE the
      // Execution Board page. The old /status-board route (admin-defined
      // milestones) is still mounted for back-compat / deep-link access
      // but no longer surfaced in the sidebar.
      { label: 'Execution Board', href: '/execution-board', icon: Grid3X3 },
      { label: 'Contracts', href: '/contracts', icon: FileText },
    ],
  },
  {
    title: 'People',
    items: [
      { label: 'Partners', href: '/partners', icon: Briefcase },
      // Dedicated contacts surface — not a tab inside Partners. Has its own
      // page with view toggles (List · By Project · By Customer), filters,
      // and project enrichment.
      { label: 'Contacts', href: '/contacts', icon: UserCircle2 },
    ],
  },
  {
    title: 'Insights',
    items: [
      { label: 'Operations', href: '/operations', icon: Activity },
      { label: 'Reports', href: '/reports', icon: BarChart3 },
    ],
  },
  {
    title: 'Setup',
    items: [
      { label: 'Templates', href: '/templates', icon: Layers },
      // Internal staff used to live in the top-level nav as "People".
      // Moved into the Admin landing page as the "Employees" card —
      // more natural since it manages login accounts + role assignments.
      { label: 'Admin', href: '/admin', icon: Settings },
    ],
  },
];

/**
 * Flat list of nav items in section order — retained as an alias so
 * mobile-nav.tsx (and any other flat-list caller) doesn't need to
 * change. The sidebar prefers NAV_SECTIONS to keep the grouping.
 */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

export const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 5);
