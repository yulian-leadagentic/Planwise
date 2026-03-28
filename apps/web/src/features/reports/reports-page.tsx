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

const reportCards = [
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
  },
  {
    title: 'Cost Report',
    description: 'Labor and expense costs by project/task',
    icon: DollarSign,
    href: '/reports/cost',
    color: 'bg-emerald-100 text-emerald-700',
  },
  {
    title: 'Milestones',
    description: 'Milestone progress and upcoming deadlines',
    icon: Milestone,
    href: '/reports/milestones',
    color: 'bg-orange-100 text-orange-700',
  },
  {
    title: 'Billing Forecast',
    description: 'Upcoming billings and revenue projections',
    icon: BarChart3,
    href: '/reports/billing-forecast',
    color: 'bg-rose-100 text-rose-700',
  },
];

export function ReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="View and export reports" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {reportCards.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="rounded-lg border bg-card p-5 hover:shadow-md transition-shadow"
          >
            <div className={`inline-flex p-2 rounded-lg ${card.color} mb-3`}>
              <card.icon className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-sm">{card.title}</h3>
            <p className="text-xs text-muted-foreground mt-1">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
