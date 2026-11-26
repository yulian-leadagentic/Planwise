import { useEffect, useRef, useState } from 'react';

/**
 * QA6 round 2 (26.11) · finding 2: a very fast drag got the Workload
 * board stuck in drag mode.
 *
 * Why: when pointerdown, a move past the 5 px activation and pointerup
 * all land inside one frame, @dnd-kit/core 6.3 calls `onDragStart` (the
 * board sets `active`) and then handles the release before React has
 * rendered the drag. Its end handler reads the active item from a ref
 * that is filled after that render, finds nothing, and skips
 * `onDragEnd` / `onDragCancel`. The board keeps `active` forever; its
 * pointer sensor is already detached, so a later pointerup or Escape
 * does nothing.
 *
 * The recovery: watch `pointerup` / `pointercancel` / Escape on the
 * document. Once one of them means the drag must be over and dnd-kit has
 * not ended it within STUCK_DRAG_TIMEOUT_MS, the board cancels the drag
 * itself (clears `active` and remounts the DndContext so no stuck
 * internal state survives). A normal drop or cancel ends the drag
 * synchronously inside the same event, far inside the window.
 *
 *   - Pointer drags: pointerup, pointercancel and Escape count. A release
 *     seen BEFORE `onDragStart` but after the pointerdown that started
 *     the drag also counts (the drag already ended in the same frame).
 *   - Keyboard drags: only Escape counts. A mouse click during a keyboard
 *     drag is not an end signal for dnd-kit, so it is not one here.
 *
 * A delay/tolerance activation constraint was not used: it cannot rule
 * the race out (all events can still share a frame) and it makes every
 * normal drag wait.
 */

export const STUCK_DRAG_TIMEOUT_MS = 300;

export type DragVia = 'pointer' | 'keyboard';
export type DragEndSignal = 'pointerup' | 'pointercancel' | 'escape';

/** How the drag was started, from dnd-kit's activator event (pointerdown or keydown). */
export function dragVia(activatorEvent: { type?: string } | null | undefined): DragVia {
  return activatorEvent?.type?.startsWith('key') ? 'keyboard' : 'pointer';
}

/** Does `signal` mean a drag started via `via` must be over? */
export function endsDrag(signal: DragEndSignal, via: DragVia): boolean {
  return signal === 'escape' || via === 'pointer';
}

export type StuckDragWatchdog = {
  /** dnd-kit reported a drag start; `startedAt` = the activator event's timeStamp. */
  started(via: DragVia, startedAt?: number): void;
  /** dnd-kit reported the drag's end or cancel (or the board recovered). */
  ended(): void;
  /** A pointerup / pointercancel / Escape reached the document; `at` = its timeStamp. */
  signal(signal: DragEndSignal, at: number): void;
  /** Whether a recovery is scheduled (for specs). */
  readonly armed: boolean;
};

export function createStuckDragWatchdog({
  onStuck,
  timeoutMs = STUCK_DRAG_TIMEOUT_MS,
}: {
  onStuck: () => void;
  timeoutMs?: number;
}): StuckDragWatchdog {
  let drag: { via: DragVia; startedAt: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRelease = Number.NEGATIVE_INFINITY;

  const disarm = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!drag) return;
      drag = null;
      onStuck();
    }, timeoutMs);
  };

  return {
    started(via, startedAt = Number.POSITIVE_INFINITY) {
      disarm();
      drag = { via, startedAt };
      // The release already reached the document after the pointerdown
      // that started this drag: it began and ended inside one frame.
      if (via === 'pointer' && lastRelease >= startedAt) arm();
    },
    ended() {
      drag = null;
      disarm();
    },
    signal(signal, at) {
      if (signal !== 'escape') lastRelease = Math.max(lastRelease, at);
      if (drag && endsDrag(signal, drag.via)) arm();
    },
    get armed() {
      return timer != null;
    },
  };
}

/**
 * The watchdog wired to the document for the lifetime of the board. Call
 * `started` from `onDragStart` and `ended` from `onDragEnd` /
 * `onDragCancel`; `onStuck` runs when a drag outlived its end signal.
 */
export function useStuckDragRecovery(onStuck: () => void, timeoutMs = STUCK_DRAG_TIMEOUT_MS): StuckDragWatchdog {
  const onStuckRef = useRef(onStuck);
  useEffect(() => {
    onStuckRef.current = onStuck;
  }, [onStuck]);
  const [watchdog] = useState(() => createStuckDragWatchdog({ timeoutMs, onStuck: () => onStuckRef.current() }));

  useEffect(() => {
    const onPointer = (e: PointerEvent) => watchdog.signal(e.type === 'pointercancel' ? 'pointercancel' : 'pointerup', e.timeStamp);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') watchdog.signal('escape', e.timeStamp);
    };
    // Capture phase: seen even when a handler below stops propagation.
    document.addEventListener('pointerup', onPointer, true);
    document.addEventListener('pointercancel', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerup', onPointer, true);
      document.removeEventListener('pointercancel', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      watchdog.ended();
    };
  }, [watchdog]);

  return watchdog;
}
