import { CalendarCheck, Calendar, FileSpreadsheet, Settings2, ScrollText, Users } from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * HR Phase A4 (2026-10-15) · §15 R1 (2026-10-18) · F2 (2026-10-19).
 * F2 reverses §15 R2 — Calendar moves back from Admin into HR, so an
 * HR Manager owns holidays alongside Monthly Review / Reports /
 * Settings. The sub-nav now shows four tabs in the order Yulian
 * fixed: סקירה חודשית · לוח שנה · דוחות · הגדרות.
 *
 * `module: 'hr'` on every row drives SubNavLayout's visibility
 * filter — a role without hr:read sees nothing here (and
 * RoutePermissionGuard redirects them off `/hr` entirely). Edit
 * controls inside the calendar page itself check `hr:write`.
 *
 * Permissions round 3 (2026-11-22) — fifth tab, יומן ביקורת (HR audit).
 * HR audit rows are for hr:read holders only, with NO admin bypass (the
 * API refuses an Admin without the HR grant), so the tab is added only
 * when the caller really holds hr:read — SubNavLayout's own filter would
 * show it to every Admin.
 *
 * Permissions round 3 (2026-11-22) — עובדים (Employees) opens the
 * employee list at /people. HR-only users may now read GET /users and
 * /people accepts hr:read, but the sidebar Admin item and the /admin hub
 * need admin:read, so without this link HR had no menu path to it.
 * Same hr:read-only rule as the audit tab (Admins have the Admin menu).
 */
const HR_ITEMS: SubNavItem[] = [
  { label: 'סקירה חודשית',  href: '/hr/review',    icon: CalendarCheck,    module: 'hr' },
  { label: 'לוח שנה',       href: '/hr/calendar',  icon: Calendar,         module: 'hr' },
  { label: 'דוחות',          href: '/hr/reports',   icon: FileSpreadsheet,  module: 'hr' },
  { label: 'הגדרות',         href: '/hr/settings',  icon: Settings2,        module: 'hr' },
];

const EMPLOYEES_ITEM: SubNavItem = { label: 'עובדים', href: '/people', icon: Users, module: 'hr' };
const AUDIT_ITEM: SubNavItem = { label: 'יומן ביקורת', href: '/hr/audit', icon: ScrollText, module: 'hr' };

export function HrLayout() {
  const { can } = usePermissions();
  const items = can('hr', 'read') ? [...HR_ITEMS, EMPLOYEES_ITEM, AUDIT_ITEM] : HR_ITEMS;
  return (
    <SubNavLayout
      title="HR"
      description="Monthly review, calendar, reports, employees, audit, and HR settings"
      items={items}
      homeHref="/hr"
      homeLabel="Overview"
    />
  );
}
