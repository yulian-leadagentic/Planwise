import { useState, useEffect } from 'react';
import { Play, Square } from 'lucide-react';
import { useClockStatus, useClockIn, useClockOut } from '@/hooks/use-time';
import { minutesToDisplay } from '@/types';
import { cn } from '@/lib/utils';

export function ClockWidget() {
  const { data: clockStatus } = useClockStatus();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!clockStatus?.isClockedIn || !clockStatus.clockInAt) {
      setElapsed(0);
      return;
    }

    const clockInTime = new Date(clockStatus.clockInAt).getTime();

    function update() {
      const now = Date.now();
      setElapsed(Math.floor((now - clockInTime) / 60000));
    }

    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [clockStatus?.isClockedIn, clockStatus?.clockInAt]);

  if (!clockStatus) return null;

  if (clockStatus.isClockedIn) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
          <span className="text-sm font-medium">{minutesToDisplay(elapsed)}</span>
        </div>
        <button
          onClick={() => clockOut.mutate()}
          disabled={clockOut.isPending}
          className={cn(
            'flex items-center gap-1 rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600',
            clockOut.isPending && 'opacity-50',
          )}
        >
          <Square className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Out</span>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => clockIn.mutate()}
      disabled={clockIn.isPending}
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700',
        clockIn.isPending && 'opacity-50',
      )}
    >
      <Play className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Clock In</span>
    </button>
  );
}
