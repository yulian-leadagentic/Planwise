import { CalendarCheck, Calendar, FileSpreadsheet, Settings2 } from 'lucide-react';
import { SubNavLayout, type SubNavItem } from '@/components/layout/sub-nav-layout';

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
 */
const HR_ITEMS: SubNavItem[] = [
  { label: 'סקירה חודשית',  href: '/hr/review',    icon: CalendarCheck,    module: 'hr' },
  { label: 'לוח שנה',       href: '/hr/calendar',  icon: Calendar,         module: 'hr' },
  { label: 'דוחות',          href: '/hr/reports',   icon: FileSpreadsheet,  module: 'hr' },
  { label: 'הגדרות',         href: '/hr/settings',  icon: Settings2,        module: 'hr' },
];

export function HrLayout() {
  return (
    <SubNavLayout
      title="HR"
      description="Monthly review, calendar, reports, and HR settings"
      items={HR_ITEMS}
      homeHref="/hr"
      homeLabel="Overview"
    />
  );
}
