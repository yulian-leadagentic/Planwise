import {
  LayoutDashboard,
  Clock,
  FolderKanban,
  FileText,
  Users,
  BarChart3,
  Layers,
  Settings,
  MessageSquare,
  CheckSquare,
  Activity,
  Grid3X3,
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

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Operations', href: '/operations', icon: Activity },
  { label: 'Execution Board', href: '/execution-board', icon: Grid3X3 },
  { label: 'Projects', href: '/projects', icon: FolderKanban },
  { label: 'My Tasks', href: '/my-tasks', icon: CheckSquare },
  { label: 'Inbox', href: '/inbox', icon: MessageSquare },
  { label: 'Time', href: '/time', icon: Clock },
  { label: 'Contracts', href: '/contracts', icon: FileText },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Templates', href: '/templates', icon: Layers },
  { label: 'Admin', href: '/admin', icon: Settings },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 5);
