import { Clock, AlertTriangle, LogOut, Palmtree } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { UserAvatar } from '@/components/shared/user-avatar';
import { useTeamClockDashboard } from '@/hooks/use-time';
import { formatTime } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { PageSkeleton } from '@/components/shared/loading-skeleton';

export function ClockDashboardPage() {
  const { data: dashboard, isLoading, isError, refetch } = useTeamClockDashboard();

  if (isLoading) return <PageSkeleton />;

  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Clock Dashboard"
          description="Real-time team attendance overview"
        />
        <div className="rounded-lg border border-border bg-background p-8 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Couldn't load the clock dashboard.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!dashboard) return null;

  // Defensive fallbacks: tolerate a backend response that's missing
  // a bucket (older API, partial deploy, mock data) instead of crashing
  // with "Cannot read properties of undefined (reading 'length')".
  // FIX: these previously referenced themselves (e.g.
  // `const clockedIn = clockedIn ?? []`), throwing a ReferenceError on
  // every render and leaving the page blank. Read from `dashboard.*`.
  const clockedIn = dashboard.clockedIn ?? [];
  const notYet = dashboard.notYet ?? [];
  const late = dashboard.late ?? [];
  const onLeave = dashboard.onLeave ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clock Dashboard"
        description="Real-time team attendance overview"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Clocked In */}
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
              <Clock className="h-4 w-4 text-green-600" />
            </div>
            <h3 className="font-medium">
              Clocked In ({clockedIn.length})
            </h3>
          </div>
          <div className="space-y-2">
            {clockedIn.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one clocked in yet</p>
            ) : (
              clockedIn.map((record) => (
                <div key={record.id} className="flex items-center gap-3 rounded-md bg-green-50 p-2 dark:bg-green-900/10">
                  <UserAvatar
                    firstName={record.user.firstName}
                    lastName={record.user.lastName}
                    avatarUrl={record.user.avatarUrl}
                    size="sm"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {record.user.firstName} {record.user.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      In at {formatTime(record.clockIn)}
                      {record.totalMinutes != null && ` - ${minutesToDisplay(record.totalMinutes)}`}
                    </p>
                  </div>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Not Yet Clocked In */}
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 dark:bg-slate-800">
              <LogOut className="h-4 w-4 text-gray-600 dark:text-slate-300" />
            </div>
            <h3 className="font-medium">
              Not Yet ({notYet.length})
            </h3>
          </div>
          <div className="space-y-2">
            {notYet.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Everyone is clocked in</p>
            ) : (
              notYet.map((item) => (
                <div key={item.user.id} className="flex items-center gap-3 rounded-md bg-muted/50 p-2">
                  <UserAvatar firstName={item.user.firstName} lastName={item.user.lastName} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {item.user.firstName} {item.user.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Expected at {item.expectedShiftStart}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Late */}
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-100">
              <AlertTriangle className="h-4 w-4 text-orange-600" />
            </div>
            <h3 className="font-medium">
              Late ({late.length})
            </h3>
          </div>
          <div className="space-y-2">
            {late.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one is late today</p>
            ) : (
              late.map((record) => (
                <div key={record.id} className="flex items-center gap-3 rounded-md bg-orange-50 p-2 dark:bg-orange-900/10">
                  <UserAvatar firstName={record.user.firstName} lastName={record.user.lastName} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {record.user.firstName} {record.user.lastName}
                    </p>
                    <p className="text-xs text-orange-600">
                      {record.lateMinutes}m late
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* On Leave */}
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100">
              <Palmtree className="h-4 w-4 text-blue-600" />
            </div>
            <h3 className="font-medium">
              On Leave ({onLeave.length})
            </h3>
          </div>
          <div className="space-y-2">
            {onLeave.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one on leave</p>
            ) : (
              onLeave.map((record) => (
                <div key={record.id} className="flex items-center gap-3 rounded-md bg-blue-50 p-2 dark:bg-blue-900/10">
                  <UserAvatar firstName={record.user.firstName} lastName={record.user.lastName} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      {record.user.firstName} {record.user.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {record.status.replace(/_/g, ' ')}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
