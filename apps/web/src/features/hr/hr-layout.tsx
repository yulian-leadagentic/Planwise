import { CalendarCheck, FileSpreadsheet, Settings2 } from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';

/**
 * HR Phase A4 (2026-10-15) · §15 R1 (2026-10-18). The sub-nav shrinks
 * from 4 tabs to 3 — the "Employees" roster folded into Admin→Users
 * edit as an HR tab, so the dedicated roster disappeared. Monthly
 * Review is the new default landing (app-router redirects /hr and
 * /hr/employees to /hr/review).
 *
 * `module: 'hr'` on every row drives SubNavLayout's visibility
 * filter — a role without hr:read sees nothing here (and
 * RoutePermissionGuard redirects them off `/hr` entirely).
 */
const HR_ITEMS: SubNavItem[] = [
  { label: 'Monthly Review',  href: '/hr/review',    icon: CalendarCheck,    module: 'hr' },
  { label: 'Reports',         href: '/hr/reports',   icon: FileSpreadsheet,  module: 'hr' },
  { label: 'Settings',        href: '/hr/settings',  icon: Settings2,        module: 'hr' },
];

export function HrLayout() {
  return (
    <SubNavLayout
      title="HR"
      description="Monthly review, consolidated reports, and HR settings"
      items={HR_ITEMS}
      homeHref="/hr"
      homeLabel="Overview"
    />
  );
}
