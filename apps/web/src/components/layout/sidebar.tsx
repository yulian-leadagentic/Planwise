import { NavLink } from 'react-router-dom';
import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { NAV_ITEMS } from '@/lib/constants';
import { useUIStore } from '@/stores/ui.store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';

const NAV_MODULE_MAP: Record<string, string> = {
  '/': 'dashboard',
  '/operations': 'operations',
  '/execution-board': 'projects',
  '/projects': 'projects',
  '/my-tasks': 'tasks',
  '/inbox': 'tasks',
  '/time': 'time',
  '/contracts': 'contracts',
  '/partners': 'partners',
  '/reports': 'reports',
  '/templates': 'templates',
  '/admin': 'admin',
};

export function Sidebar() {
  const isDesktop = useIsDesktop();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);

  const { can, isAdmin } = usePermissions();

  const visibleNavItems = useMemo(() => {
    if (isAdmin) return NAV_ITEMS;
    return NAV_ITEMS.filter((item) => {
      const mod = NAV_MODULE_MAP[item.href];
      if (!mod) return true;
      return can(mod, 'read');
    });
  }, [can, isAdmin]);

  // On tablet, always collapsed unless toggled
  const isCollapsed = !isDesktop || sidebarCollapsed;

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200',
        isCollapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        {isCollapsed ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            A
          </div>
        ) : (
          <span className="text-xl font-bold text-brand-600">AMEC</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            end={item.href === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                isCollapsed && 'justify-center px-2',
              )
            }
            title={isCollapsed ? item.label : undefined}
          >
            <item.icon className="h-5 w-5 shrink-0" />
            {!isCollapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Collapse toggle - desktop only */}
      {isDesktop && (
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="flex h-10 items-center justify-center border-t border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      )}
    </aside>
  );
}
