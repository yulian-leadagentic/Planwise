import { Link } from 'react-router-dom';
import {
  Clock,
  CalendarCheck,
  Timer,
  AlertCircle,
  DollarSign,
  Milestone,
  BarChart3,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { usePermissions } from '@/hooks/use-permissions';

interface ReportCard {
  title: string;
  description: string;
  icon: any;
  href: string;
  color: string;
  /** When true, only users with finance:read see this card. */
  requiresFinance?: boolean;
  /** When true, the report page is not implemented yet — the card is shown
   *  as a disabled "Soon" tile instead of a link to an empty placeholder. */
  comingSoon?: boolean;
}

const reportCards: ReportCard[] = [
  {
    title: 'Timesheet Report',
    description: 'Hours logged by user, project, or label',
    icon: Clock,
    href: '/reports/timesheet',
    color: 'bg-blue-100 text-blue-700',
  },
  {
    title: 'Attendance',
    description: 'Presence, absence, sick days, and leave',
    icon: CalendarCheck,
    href: '/reports/attendance',
    color: 'bg-green-100 text-green-700',
  },
  {
    title: 'Overtime',
    description: 'Overtime hours by employee',
    icon: Timer,
    href: '/reports/overtime',
    color: 'bg-purple-100 text-purple-700',
  },
  {
    title: 'Late Arrivals',
    description: 'Employees who clocked in late',
    icon: AlertCircle,
    href: '/reports/late-arrivals',
    color: 'bg-amber-100 text-amber-700',
    comingSoon: true,
  },
  {
    title: 'Cost Report',
    description: 'Labor and expense costs by project/task',
    icon: DollarSign,
    href: '/reports/cost',
    color: 'bg-emerald-100 text-emerald-700',
    requiresFinance: true,
  },
  {
    title: 'Milestones',
    description: 'Milestone progress and upcoming deadlines',
    icon: Milestone,
    href: '/reports/milestones',
    color: 'bg-orange-100 text-orange-700',
    comingSoon: true,
  },
  {
    title: 'Billing Forecast',
    description: 'Upcoming billings and revenue projections',
    icon: BarChart3,
    href: '/reports/billing-forecast',
    color: 'bg-rose-100 text-rose-700',
    requiresFinance: true,
    comingSoon: true,
  },
];

export function ReportsPage() {
  // Finance perm — gates the Cost Report + Billing Forecast cards.
  // No admin bypass; even admins need the explicit grant.
  const { can } = usePermissions();
  const showFinance = can('finance', 'read');
  // Hide finance-tagged cards entirely when the caller lacks the
  // permission — matches the backend gate on /reports/cost/* and the
  // billing-forecast endpoint.
  const visibleCards = reportCards.filter((c) => !c.requiresFinance || showFinance);

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="View and export reports" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleCards.map((card) => {
          const inner = (
            <>
              <div className={`inline-flex p-2 rounded-lg ${card.color} mb-3`}>
                <card.icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-sm flex items-center gap-2">
                {card.title}
                {card.comingSoon && (
                  <span className="rounded-[5px] bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    Soon
                  </span>
                )}
              </h3>
              <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
            </>
          );

          // Not-yet-implemented reports render as a disabled tile rather than
          // linking to an empty placeholder page (avoids a dead-end click).
          if (card.comingSoon) {
            return (
              <div
                key={card.href}
                aria-disabled="true"
                className="rounded-lg border bg-card p-5 opacity-60 cursor-not-allowed"
                title="Coming soon"
              >
                {inner}
              </div>
            );
          }

          return (
            <Link
              key={card.href}
              to={card.href}
              className="rounded-lg border bg-card p-5 hover:border-brand-400 transition-colors"
            >
              {inner}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
