/**
 * QA6 round 2 (26.11) · finding 2: a pointerdown → move → pointerup that
 * all land inside one frame left the Workload board stuck in drag mode
 * (dnd-kit called onDragStart but never onDragEnd). The watchdog cancels
 * such a drag once a release / Escape is not followed by an end within
 * 300 ms, and leaves normal pointer and keyboard drags alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUCK_DRAG_TIMEOUT_MS, createStuckDragWatchdog, dragVia, endsDrag } from './workload-drag-recovery';

function setup() {
  const onStuck = vi.fn();
  const wd = createStuckDragWatchdog({ onStuck });
  return { wd, onStuck };
}

describe('workload drag recovery · the watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the timeout is about 300 ms', () => {
    expect(STUCK_DRAG_TIMEOUT_MS).toBe(300);
  });

  it('a normal pointer drop: dnd-kit ends the drag in the same event, nothing is cancelled', () => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100);
    wd.signal('pointerup', 900);
    wd.ended(); // onDragEnd, synchronously after the release
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
    expect(wd.armed).toBe(false);
  });

  it('dnd-kit may end the drag before the document sees the release: still nothing to do', () => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100);
    wd.ended();
    wd.signal('pointerup', 900);
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('the stuck drag: a pointerup with no onDragEnd is cancelled after 300 ms, once', () => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100); // onDragStart at 105 ms, inside the same frame
    wd.signal('pointerup', 111); // dnd-kit handles it but skips onDragEnd
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS - 1);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStuck).toHaveBeenCalledTimes(1);
    // A later release does not cancel twice.
    wd.signal('pointerup', 2_000);
    vi.advanceTimersByTime(5_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('a release seen BEFORE onDragStart (after the drag’s own pointerdown) is enough: no further input needed', () => {
    const { wd, onStuck } = setup();
    wd.signal('pointerup', 111);
    wd.started('pointer', 100); // activator pointerdown at 100, release at 111
    expect(wd.armed).toBe(true);
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('an older release (a click before this drag) does not count', () => {
    const { wd, onStuck } = setup();
    wd.signal('pointerup', 50);
    wd.started('pointer', 100);
    expect(wd.armed).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'escape'] as const)('a %s with no end also recovers a pointer drag', (signal) => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100);
    wd.signal(signal, 400);
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('a long, live pointer drag is never cancelled while the button is down', () => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100);
    vi.advanceTimersByTime(60_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('keyboard drag: a mouse click meanwhile does not end it; Space to drop ends it normally', () => {
    const { wd, onStuck } = setup();
    wd.started('keyboard', 100);
    wd.signal('pointerup', 500);
    wd.signal('pointercancel', 600);
    expect(wd.armed).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
    wd.ended();
    expect(wd.armed).toBe(false);
  });

  it('keyboard drag: Escape that dnd-kit handles (onDragCancel) is not cancelled again', () => {
    const { wd, onStuck } = setup();
    wd.started('keyboard', 100);
    wd.signal('escape', 500);
    wd.ended();
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('keyboard drag: Escape with no cancel from dnd-kit recovers', () => {
    const { wd, onStuck } = setup();
    wd.started('keyboard', 100);
    wd.signal('escape', 500);
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('a new drag after a recovery starts clean', () => {
    const { wd, onStuck } = setup();
    wd.started('pointer', 100);
    wd.signal('pointerup', 111);
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
    wd.started('pointer', 5_000);
    expect(wd.armed).toBe(false);
    wd.signal('pointerup', 5_400);
    wd.ended();
    vi.advanceTimersByTime(5_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('signals with no drag in progress do nothing', () => {
    const { wd, onStuck } = setup();
    wd.signal('pointerup', 10);
    wd.signal('escape', 20);
    vi.advanceTimersByTime(5_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('no activator timestamp: only a later release arms it', () => {
    const { wd, onStuck } = setup();
    wd.signal('pointerup', 10);
    wd.started('pointer');
    expect(wd.armed).toBe(false);
    wd.signal('pointerup', 20);
    vi.advanceTimersByTime(STUCK_DRAG_TIMEOUT_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });
});

describe('workload drag recovery · helpers', () => {
  it('dragVia reads the activator event', () => {
    expect(dragVia({ type: 'pointerdown' })).toBe('pointer');
    expect(dragVia({ type: 'keydown' })).toBe('keyboard');
    expect(dragVia(null)).toBe('pointer');
  });

  it('endsDrag: Escape ends any drag; a pointer release ends only a pointer drag', () => {
    expect(endsDrag('escape', 'keyboard')).toBe(true);
    expect(endsDrag('escape', 'pointer')).toBe(true);
    expect(endsDrag('pointerup', 'pointer')).toBe(true);
    expect(endsDrag('pointercancel', 'pointer')).toBe(true);
    expect(endsDrag('pointerup', 'keyboard')).toBe(false);
    expect(endsDrag('pointercancel', 'keyboard')).toBe(false);
  });
});
