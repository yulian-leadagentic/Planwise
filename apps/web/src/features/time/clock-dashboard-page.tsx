import { Clock, AlertTriangle, LogOut, Palmtree } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { UserAvatar } from '@/components/shared/user-avatar';
import { useTeamClockDashboard } from '@/hooks/use-time';
import { formatTime } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { PageSkeleton } from '@/components/shared/loading-skeleton';

export function ClockDashboardPage() {
  const { data: dashboard, isLoading } = useTeamClockDashboard();

  if (isLoading) return <PageSkeleton />;
  if (!dashboard) return null;

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
              Clocked In ({dashboard.clockedIn.length})
            </h3>
          </div>
          <div className="space-y-2">
            {dashboard.clockedIn.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one clocked in yet</p>
            ) : (
              dashboard.clockedIn.map((record) => (
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
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100">
              <LogOut className="h-4 w-4 text-gray-600" />
            </div>
            <h3 className="font-medium">
              Not Yet ({dashboard.notYet.length})
            </h3>
          </div>
          <div className="space-y-2">
            {dashboard.notYet.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Everyone is clocked in</p>
            ) : (
              dashboard.notYet.map((item) => (
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
              Late ({dashboard.late.length})
            </h3>
          </div>
          <div className="space-y-2">
            {dashboard.late.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one is late today</p>
            ) : (
              dashboard.late.map((record) => (
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
              On Leave ({dashboard.onLeave.length})
            </h3>
          </div>
          <div className="space-y-2">
            {dashboard.onLeave.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No one on leave</p>
            ) : (
              dashboard.onLeave.map((record) => (
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
