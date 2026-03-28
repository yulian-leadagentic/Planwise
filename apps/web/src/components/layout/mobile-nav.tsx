import { NavLink } from 'react-router-dom';
import { MOBILE_NAV_ITEMS } from '@/lib/constants';
import { cn } from '@/lib/utils';

export function MobileNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background safe-area-pb">
      <div className="flex h-14 items-center justify-around">
        {MOBILE_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            end={item.href === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors',
                isActive
                  ? 'text-brand-600'
                  : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            <item.icon className="h-5 w-5" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
