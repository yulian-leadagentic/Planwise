import { NavLink, Outlet } from 'react-router-dom';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * SubNavLayout — a persistent secondary sidebar for sections that own
 * many sub-pages (Admin, Templates). Renders a fixed-width list on the
 * left with the outlet content on the right. Hits the same permission
 * gate the hub pages use, so a user sees the same items in either place.
 *
 * On viewports below `lg` the sub-nav collapses behind a hamburger
 * button so the primary content area gets full width; opening the
 * menu overlays it and closes on link click.
 *
 * URLs are unaffected — this component only groups routes visually.
 * Every item's href is an absolute path so the sidebar can be reused
 * outside its parent route without href rewrites.
 */

export interface SubNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Permission module string. Anything left null shows to all users. */
  module?: string;
  /** Optional grouping — items with the same group name render under
   *  that heading. Groups appear in first-seen order. */
  group?: string;
}

interface SubNavLayoutProps {
  title: string;
  description?: string;
  items: SubNavItem[];
  /** Where the hub page lives, so the "back to hub" link is correct
   *  when set. Also becomes the `end`-matched home item at the top. */
  homeHref: string;
  homeLabel?: string;
}

export function SubNavLayout({ title, description, items, homeHref, homeLabel = 'Overview' }: SubNavLayoutProps) {
  const { can, isAdmin } = usePermissions();
  const [mobileOpen, setMobileOpen] = useState(false);

  const visible = items.filter((it) => isAdmin || !it.module || can(it.module, 'read'));

  // Group items in first-seen order. Ungrouped items go into an unnamed
  // bucket that renders as a flat list at the top with no header.
  const grouped: Array<{ group: string | null; items: SubNavItem[] }> = [];
  const idx = new Map<string | null, number>();
  for (const it of visible) {
    const key = it.group ?? null;
    if (!idx.has(key)) {
      idx.set(key, grouped.length);
      grouped.push({ group: key, items: [] });
    }
    grouped[idx.get(key)!].items.push(it);
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
      isActive
        ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
    );

  const navList = (
    <nav className="space-y-4">
      {/* Overview link — always the first row, matches the hub page. */}
      <NavLink to={homeHref} end className={linkClass} onClick={() => setMobileOpen(false)}>
        <span className="text-[13px]">{homeLabel}</span>
      </NavLink>
      {grouped.map((g) => (
        <div key={g.group ?? '__ungrouped__'} className="space-y-0.5">
          {g.group && (
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {g.group}
            </p>
          )}
          {g.items.map((it) => {
            const Icon = it.icon;
            return (
              <NavLink
                key={it.href}
                to={it.href}
                end
                className={linkClass}
                onClick={() => setMobileOpen(false)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                <span className="truncate">{it.label}</span>
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="lg:flex lg:gap-6">
      {/* Mobile trigger — visible below lg. Renders the sub-nav as an
          overlay sheet so it doesn't shove primary content around. */}
      <div className="lg:hidden mb-3 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100 truncate">{title}</h1>
          {description && (
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400 truncate">{description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={`Open ${title} sub-navigation`}
          aria-expanded={mobileOpen}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200"
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${title} sub-navigation`}>
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700 shadow-2xl p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{title}</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close sub-navigation"
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {navList}
          </div>
        </div>
      )}

      {/* Desktop sub-nav — persistent left column. Sticky so it stays
          in view when the content column scrolls. */}
      <aside className="hidden lg:block lg:w-56 shrink-0">
        <div className="sticky top-4">
          <div className="mb-4">
            <h1 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h1>
            {description && (
              <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">{description}</p>
            )}
          </div>
          {navList}
        </div>
      </aside>

      {/* Primary content — the routed sub-page. min-w-0 keeps flex kids
          from overflowing when their content is wider than the column. */}
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
