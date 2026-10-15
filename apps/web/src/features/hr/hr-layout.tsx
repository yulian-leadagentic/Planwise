import { Users, CalendarCheck, FileSpreadsheet, Settings2 } from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';

/**
 * HR Phase A4 (2026-10-15) — the 4 HR tabs per spec §2. Only
 * Employees is wired in Phase A; the other three render a "Coming
 * soon" placeholder so the sub-nav shape doesn't shift when Phase
 * B/C lights them up.
 *
 * `module: 'hr'` on every row drives the SubNavLayout's visibility
 * filter — a role without hr:read sees nothing here (and
 * RoutePermissionGuard redirects them off `/hr` entirely).
 */
const HR_ITEMS: SubNavItem[] = [
  { label: 'Employees',       href: '/hr/employees', icon: Users,            module: 'hr' },
  { label: 'Monthly Review',  href: '/hr/review',    icon: CalendarCheck,    module: 'hr' },
  { label: 'Reports',         href: '/hr/reports',   icon: FileSpreadsheet,  module: 'hr' },
  { label: 'Settings',        href: '/hr/settings',  icon: Settings2,        module: 'hr' },
];

export function HrLayout() {
  return (
    <SubNavLayout
      title="HR"
      description="Employees, time review, and payroll settings"
      items={HR_ITEMS}
      homeHref="/hr"
      homeLabel="Overview"
    />
  );
}
