import { Outlet } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { MobileNav } from './mobile-nav';
import { Header } from './header';
import { useIsMobile, useIsDesktop } from '@/hooks/use-media-query';
import { useUIStore } from '@/stores/ui.store';
import { cn } from '@/lib/utils';

export function AppShell() {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar - hidden on mobile, slim on tablet, full on desktop */}
      {!isMobile && <Sidebar />}

      {/* Main content area */}
      <div
        className={cn(
          'flex flex-1 flex-col overflow-hidden',
          !isMobile && (sidebarCollapsed ? 'ml-16' : isDesktop ? 'ml-64' : 'ml-16'),
        )}
      >
        <Header />

        <main className={cn('flex-1 overflow-y-auto', isMobile ? 'pb-16' : 'pb-4')}>
          <div className="px-4 py-4 sm:px-5">
            <Outlet />
          </div>
        </main>

        {/* Bottom navigation - mobile only */}
        {isMobile && <MobileNav />}
      </div>
    </div>
  );
}
