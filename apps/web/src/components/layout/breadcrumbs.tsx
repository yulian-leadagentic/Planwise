import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

const ROUTE_LABELS: Record<string, string> = {
  '': 'Dashboard',
  tasks: 'Tasks',
  time: 'Time',
  grid: 'Weekly Grid',
  'clock-dashboard': 'Clock Dashboard',
  projects: 'Projects',
  new: 'New',
  edit: 'Edit',
  contracts: 'Contracts',
  people: 'Employees',
  employees: 'Employees',
  reports: 'Reports',
  templates: 'Templates',
  admin: 'Admin',
  profile: 'Profile',
};

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  const crumbs = segments.map((segment, index) => {
    const path = '/' + segments.slice(0, index + 1).join('/');
    const label = ROUTE_LABELS[segment] || (isNaN(Number(segment)) ? segment : `#${segment}`);
    const isLast = index === segments.length - 1;

    return { path, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link to="/" className="hover:text-foreground">
        <Home className="h-4 w-4" />
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5" />
          {crumb.isLast ? (
            <span className="font-medium text-foreground">{crumb.label}</span>
          ) : (
            <Link to={crumb.path} className="hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
