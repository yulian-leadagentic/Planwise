import {
  Shield,
  Activity,
  Clock,
  Calendar,
  Bell,
  Tags,
  Users,
  Hash,
  DollarSign,
  GraduationCap,
  Briefcase,
  Link as LinkIcon,
  Upload,
  ListChecks,
  Network,
  KeyRound,
  HardDrive,
} from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';

/**
 * The full catalog of Admin sub-pages, grouped so 18 items are still
 * scannable at a glance. Groups mirror the hub-card categories
 * roughly (Access, People config, Time & Attendance, Numbering,
 * Catalog, Communication, Data) — small enough that a user doesn't
 * need to search a long flat list. `module` matches the permission
 * strings used elsewhere so the sub-nav gates identically to the hub.
 */
const ADMIN_ITEMS: SubNavItem[] = [
  { label: 'Employees',              href: '/admin/employees',                 icon: Users,         module: 'partners',                 group: 'Access & Security' },
  { label: 'Roles & Permissions',    href: '/admin/roles',                     icon: Shield,        module: 'admin/roles',              group: 'Access & Security' },
  { label: 'Organization',           href: '/admin/organization',              icon: Network,       module: 'org',                      group: 'Access & Security' },
  { label: 'SSO / Identity',         href: '/admin/sso',                       icon: KeyRound,      module: 'org',                      group: 'Access & Security' },
  { label: 'Google Drive',           href: '/admin/drive',                     icon: HardDrive,     module: 'org',                      group: 'Access & Security' },
  { label: 'Activity Log',           href: '/admin/activity-log',              icon: Activity,      module: 'admin/activity-log',       group: 'Access & Security' },

  { label: 'Partner Types',          href: '/admin/partner-types',             icon: Tags,          module: 'admin/partner-types',      group: 'People Config' },
  { label: 'Project Role Types',     href: '/admin/project-role-types',        icon: Briefcase,     module: 'admin/project-role-types', group: 'People Config' },

  { label: 'Work Schedules',         href: '/admin/work-schedules',            icon: Calendar,      module: 'admin/work-schedules',     group: 'Time & Attendance' },
  { label: 'Calendar Days',          href: '/admin/calendar',                  icon: Calendar,      module: 'admin/calendar',           group: 'Time & Attendance' },
  { label: 'Team Clock Dashboard',   href: '/admin/clock-dashboard',           icon: Clock,         module: 'admin/clock-dashboard',    group: 'Time & Attendance' },
  { label: 'Time-log Phrases',       href: '/admin/time-note-phrases',         icon: ListChecks,    module: 'admin',                    group: 'Time & Attendance' },

  { label: 'Number Ranges',          href: '/admin/number-ranges',             icon: Hash,          module: 'admin/number-ranges',      group: 'Numbering' },
  { label: 'Object Numbering',       href: '/admin/object-numbering',          icon: LinkIcon,      module: 'admin/number-ranges',      group: 'Numbering' },

  { label: 'Currencies',             href: '/admin/currencies',                icon: DollarSign,    module: 'admin',                    group: 'Catalog' },
  { label: 'Seniority Levels',       href: '/admin/seniority-levels',          icon: GraduationCap, module: 'admin',                    group: 'Catalog' },
  { label: 'Project Stage Milestones', href: '/admin/project-stage-milestones', icon: ListChecks,   module: 'admin',                    group: 'Catalog' },

  { label: 'Notification Settings',  href: '/admin/notification-settings',     icon: Bell,          module: 'admin/notification-settings', group: 'Communication' },

  { label: 'Data Import',            href: '/admin/data-import',               icon: Upload,        module: 'data-import',              group: 'Data' },
];

export function AdminLayout() {
  return (
    <SubNavLayout
      title="Administration"
      description="System configuration and management"
      items={ADMIN_ITEMS}
      homeHref="/admin"
      homeLabel="Overview"
    />
  );
}
