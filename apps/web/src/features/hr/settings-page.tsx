import { useState } from 'react';
import { Clock, FileClock, Boxes } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { Tabs, type TabItem } from '@/components/shared/tabs';
import { ShortDaySection } from './settings/short-day-section';
import { AbsenceTypesSection } from './settings/absence-types-section';
import { BucketsSection } from './settings/buckets-section';

/**
 * HR Phase B4 (2026-10-15) · §15 R2+R3 (2026-10-18) · F2 (2026-10-19).
 * F2 reversed §15 R2 and moved Calendar BACK into HR as a sibling
 * tab (/hr/calendar) instead of a jump-link card here. What remains
 * on /hr/settings is the three HR-only knobs: short-day hours,
 * absence types, special buckets.
 *
 * Permissions:
 *   • Route gated by hr:read (RoutePermissionGuard enforces).
 *   • Each section inspects `hr:write` locally and disables its save /
 *     create / edit controls when the viewer only has `hr:read` (so
 *     HR Clerk gets a read-only tour of the catalog).
 *
 * Design: slate palette, DM Sans + JetBrains Mono. `rounded-[14px]`
 * cards, no shadows, border-only. Full dark: light + dark branch per
 * the design system.
 */
type SettingsTab = 'short-day' | 'absence-types' | 'buckets';

const TABS: TabItem<SettingsTab>[] = [
  { value: 'short-day', label: 'Short day · יום מקוצר' },
  { value: 'absence-types', label: 'Absence types · סוגי היעדרויות' },
  { value: 'buckets', label: 'Special buckets · קופות מיוחדות' },
];

const TAB_ICON: Record<SettingsTab, React.ElementType> = {
  'short-day': Clock,
  'absence-types': FileClock,
  buckets: Boxes,
};

export function HrSettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('short-day');
  const Icon = TAB_ICON[tab];

  return (
    <div className="space-y-5">
      <PageHeader
        title="HR Settings"
        description="הגדרות משאבי אנוש · Organisation-wide HR knobs"
      />

      <Tabs<SettingsTab>
        items={TABS}
        value={tab}
        onChange={setTab}
        variant="pill"
        ariaLabel="HR settings sections"
      />

      <section
        role="tabpanel"
        aria-label={TABS.find((t) => t.value === tab)?.ariaLabel ?? String(tab)}
        className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
      >
        <div className="border-b border-slate-100 dark:border-slate-800 px-5 py-3 flex items-center gap-2">
          <div className="w-[22px] h-[22px] rounded-[5px] bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <h2 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">
            {TABS.find((t) => t.value === tab)?.label}
          </h2>
        </div>
        <div className="p-5">
          {tab === 'short-day' && <ShortDaySection />}
          {tab === 'absence-types' && <AbsenceTypesSection />}
          {tab === 'buckets' && <BucketsSection />}
        </div>
      </section>
    </div>
  );
}
