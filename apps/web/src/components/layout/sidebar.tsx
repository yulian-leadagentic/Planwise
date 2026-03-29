import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { NAV_ITEMS } from '@/lib/constants';
import { useUIStore } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const isDesktop = useIsDesktop();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const user = useAuthStore((s) => s.user);
  const userRole = (() => {
    if (!user) return '';
    if (user.roleName) return user.roleName.toLowerCase();
    if ((user as any).role?.name) return ((user as any).role.name as string).toLowerCase();
    return '';
  })();

  // On tablet, always collapsed unless toggled
  const isCollapsed = !isDesktop || sidebarCollapsed;

  const filteredItems = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.includes(userRole),
  );

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
        {filteredItems.map((item) => (
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
