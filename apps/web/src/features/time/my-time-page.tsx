import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, LogIn, LogOut, Grid3X3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { DailyBreakdownComponent } from './daily-breakdown';
import { LogTimeDialog } from './log-time-dialog';
import {
  useClockStatus,
  useClockIn,
  useClockOut,
  useDailyBreakdown,
  useWeeklyGrid,
} from '@/hooks/use-time';
import { getWeekDates, addDays, startOfWeek, format } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { Skeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';

export function MyTimePage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [showLogDialog, setShowLogDialog] = useState(false);
  const [logDialogDate, setLogDialogDate] = useState<string | undefined>();

  const currentWeekStart = useMemo(() => {
    const today = new Date();
    const start = startOfWeek(today, { weekStartsOn: 1 });
    return addDays(start, weekOffset * 7);
  }, [weekOffset]);

  const weekStartStr = format(currentWeekStart, 'yyyy-MM-dd');
  const weekDates = getWeekDates(currentWeekStart);

  const { data: clockStatus } = useClockStatus();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const { data: breakdown, isLoading } = useDailyBreakdown(weekStartStr);
  const { data: grid } = useWeeklyGrid({ weekStart: weekStartStr });

  const handleClockToggle = () => {
    if (clockStatus?.isClockedIn) {
      clockOut.mutate();
    } else {
      clockIn.mutate();
    }
  };

  const openLogForDate = (date?: string) => {
    setLogDialogDate(date);
    setShowLogDialog(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Time"
        description="Track your daily work hours"
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/time/grid"
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
            >
              <Grid3X3 className="h-4 w-4" />
              Weekly Grid
            </Link>
            <button
              onClick={handleClockToggle}
              disabled={clockIn.isPending || clockOut.isPending}
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50',
                clockStatus?.isClockedIn
                  ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                  : 'border border-green-200 bg-green-50 text-green-700 hover:bg-green-100',
              )}
            >
              {clockStatus?.isClockedIn ? (
                <>
                  <LogOut className="h-4 w-4" />
                  {clockIn.isPending || clockOut.isPending ? 'Processing...' : 'Clock Out'}
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" />
                  {clockIn.isPending || clockOut.isPending ? 'Processing...' : 'Clock In'}
                </>
              )}
            </button>
            <button
              onClick={() => openLogForDate()}
              className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" />
              Log Time
            </button>
          </div>
        }
      />

      {/* Clock status banner */}
      {clockStatus?.isClockedIn && (
        <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-3">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-green-500" />
          <Clock className="h-4 w-4 text-green-600" />
          <span className="text-sm font-medium text-green-700">
            Clocked in since {clockStatus.clockInAt ? format(new Date(clockStatus.clockInAt), 'HH:mm') : ''}
          </span>
          {clockStatus.elapsedMinutes != null && (
            <span className="text-sm text-green-600">
              ({minutesToDisplay(clockStatus.elapsedMinutes)} elapsed)
            </span>
          )}
        </div>
      )}

      {/* Week navigation */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-background p-3">
        <button
          onClick={() => setWeekOffset((o) => o - 1)}
          className="rounded-md p-1.5 hover:bg-accent"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="text-center">
          <p className="text-sm font-medium">
            {format(weekDates[0], 'MMM d')} - {format(weekDates[6], 'MMM d, yyyy')}
          </p>
          {weekOffset === 0 && (
            <p className="text-xs text-muted-foreground">This week</p>
          )}
        </div>
        <button
          onClick={() => setWeekOffset((o) => o + 1)}
          disabled={weekOffset >= 0}
          className="rounded-md p-1.5 hover:bg-accent disabled:opacity-50"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Week summary */}
      {grid && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-xs text-muted-foreground">Logged</p>
            <p className="text-lg font-semibold">{minutesToDisplay(grid.weekSummary.totalLogged)}</p>
          </div>
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-xs text-muted-foreground">Clocked</p>
            <p className="text-lg font-semibold">{minutesToDisplay(grid.weekSummary.totalClocked)}</p>
          </div>
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-xs text-muted-foreground">Expected</p>
            <p className="text-lg font-semibold">{minutesToDisplay(grid.weekSummary.totalExpected)}</p>
          </div>
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-xs text-muted-foreground">Overtime</p>
            <p
              className={cn(
                'text-lg font-semibold',
                grid.weekSummary.overtimeMinutes > 0
                  ? 'text-orange-600'
                  : grid.weekSummary.missingMinutes > 0
                    ? 'text-red-500'
                    : '',
              )}
            >
              {grid.weekSummary.overtimeMinutes > 0
                ? `+${minutesToDisplay(grid.weekSummary.overtimeMinutes)}`
                : grid.weekSummary.missingMinutes > 0
                  ? `-${minutesToDisplay(grid.weekSummary.missingMinutes)}`
                  : '0h'}
            </p>
          </div>
        </div>
      )}

      {/* Daily breakdown */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {(breakdown ?? []).map((day) => (
            <DailyBreakdownComponent
              key={day.date}
              day={day}
              onLogTime={() => openLogForDate(day.date)}
            />
          ))}
        </div>
      )}

      <LogTimeDialog
        open={showLogDialog}
        onClose={() => setShowLogDialog(false)}
        defaultDate={logDialogDate}
      />
    </div>
  );
}
