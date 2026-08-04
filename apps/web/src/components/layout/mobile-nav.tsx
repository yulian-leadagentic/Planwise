import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { MoreHorizontal, X } from 'lucide-react';
import { NAV_ITEMS } from '@/lib/constants';
import { cn } from '@/lib/utils';

// Show the first four destinations inline; everything else lives behind a
// "More" sheet so that ALL top-level destinations are reachable on mobile.
// (Previously mobile only exposed NAV_ITEMS.slice(0,5), leaving Inbox, Time,
// Contracts, Partners, Contacts, Reports, Templates and Admin unreachable.)
const PRIMARY = NAV_ITEMS.slice(0, 4);
const OVERFLOW = NAV_ITEMS.slice(4);

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors',
    isActive ? 'text-brand-600' : 'text-muted-foreground hover:text-foreground',
  );

export function MobileNav() {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setMoreOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">More</span>
              <button
                onClick={() => setMoreOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {OVERFLOW.map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex flex-col items-center gap-1.5 rounded-lg border border-border p-3 text-xs transition-colors',
                      isActive
                        ? 'border-brand-600 text-brand-600'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                  }
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-center leading-tight">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background safe-area-pb"
      >
        <div className="flex h-14 items-center justify-around">
          {PRIMARY.map((item) => (
            <NavLink key={item.href} to={item.href} end={item.href === '/'} className={linkClass}>
              <item.icon className="h-5 w-5" />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More navigation options"
            aria-expanded={moreOpen}
            className="flex flex-col items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <MoreHorizontal className="h-5 w-5" />
            <span>More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
