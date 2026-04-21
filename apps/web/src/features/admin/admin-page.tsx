import { Link } from 'react-router-dom';
import {
  Shield,
  Activity,
  Clock,
  Calendar,
  Users,
  Bell,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';

const adminCards = [
  {
    title: 'People Management',
    description: 'Create users, assign roles, activate / deactivate accounts',
    icon: Users,
    href: '/people',
    color: 'bg-violet-100 text-violet-700',
  },
  {
    title: 'Roles & Permissions',
    description: 'Define roles, toggle module permissions, view role members',
    icon: Shield,
    href: '/admin/roles',
    color: 'bg-blue-100 text-blue-700',
  },
  {
    title: 'Activity Log',
    description: 'View system-wide audit trail',
    icon: Activity,
    href: '/admin/activity-log',
    color: 'bg-purple-100 text-purple-700',
  },
  {
    title: 'Team Clock Dashboard',
    description: 'Real-time view of team clock status',
    icon: Clock,
    href: '/admin/clock-dashboard',
    color: 'bg-rose-100 text-rose-700',
  },
  {
    title: 'Work Schedules',
    description: 'Configure employee work schedules and shifts',
    icon: Calendar,
    href: '/admin/work-schedules',
    color: 'bg-cyan-100 text-cyan-700',
  },
  {
    title: 'Calendar Days',
    description: 'Manage holidays and company days off',
    icon: Calendar,
    href: '/admin/calendar',
    color: 'bg-orange-100 text-orange-700',
  },
  {
    title: 'Notification Settings',
    description: 'Configure notification rules, channels, and integrations',
    icon: Bell,
    href: '/admin/notification-settings',
    color: 'bg-amber-100 text-amber-700',
  },
];

export function AdminPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Administration" description="System configuration and management" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {adminCards.map((card) => (
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
