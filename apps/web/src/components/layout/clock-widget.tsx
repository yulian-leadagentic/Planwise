import { useState, useEffect } from 'react';
import { Play, Square, Calendar as CalendarIcon } from 'lucide-react';
import { useClockStatus, useClockIn, useClockOut } from '@/hooks/use-time';
import { minutesToDisplay } from '@/types';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/shared/modal';
import { TimeoffForm } from '@/features/time/timeoff-form';

/** Local "today" as yyyy-MM-dd — avoids pulling the date-utils lib
 *  into this header-adjacent component for a one-shot default. */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ClockWidget() {
  const { data: clockStatus } = useClockStatus();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [elapsed, setElapsed] = useState(0);
  // W4 (2026-10-20) — Timeoff quick-add. Opens the same TimeoffForm
  // the weekly timesheet uses; the user can pick any date (today or
  // half a year out) inside the modal.
  const [showTimeoff, setShowTimeoff] = useState(false);

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

  // W4 — secondary "+ חופש" button rendered next to BOTH states of the
  // clock CTA (clocked-in and clocked-out). Secondary style per
  // planwise-design: white bg, slate border, slate text; subtler than
  // the primary clock button so the eye lands on the main action.
  const timeoffButton = (
    <button
      type="button"
      onClick={() => setShowTimeoff(true)}
      aria-label="Report time off"
      className="flex items-center gap-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 transition-colors"
    >
      <CalendarIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">+ חופש · Timeoff</span>
    </button>
  );

  const modal = showTimeoff ? (
    <Modal
      open
      onClose={() => setShowTimeoff(false)}
      title="+ חופש · Add Timeoff"
      description="דיווח חופש לכל תאריך — גם בעתיד"
      widthClass="w-[520px] max-w-[94vw]"
    >
      <TimeoffForm
        defaultDate={todayStr()}
        onSaved={() => setShowTimeoff(false)}
        onCancel={() => setShowTimeoff(false)}
      />
    </Modal>
  ) : null;

  if (clockStatus.isClockedIn) {
    return (
      <>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
            <span className="text-sm font-medium">{minutesToDisplay(elapsed)}</span>
          </div>
          <button
            onClick={() => clockOut.mutate(undefined)}
            disabled={clockOut.isPending}
            aria-label="Clock out"
            className={cn(
              'flex items-center gap-1 rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600',
              clockOut.isPending && 'opacity-50',
            )}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Out</span>
          </button>
          {timeoffButton}
        </div>
        {modal}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={() => clockIn.mutate(undefined)}
          disabled={clockIn.isPending}
          aria-label="Clock in"
          className={cn(
            'flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700',
            clockIn.isPending && 'opacity-50',
          )}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Clock In</span>
        </button>
        {timeoffButton}
      </div>
      {modal}
    </>
  );
}
