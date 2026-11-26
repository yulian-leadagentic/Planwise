/**
 * QA6 round 3 (26.11): a drag of QA6-W5 put back where it started was
 * resolved as a drop on Ilay Edri, Mon 30/11, after the board moved about
 * 380 px during the drag. The task was reassigned and Ilay was silently
 * added to the project Team.
 *
 * Guard 1: a pointer drop acts only on the cell under the released
 * pointer; when dnd-kit's `over` is another target, nothing is written
 * and the user is told the board moved.
 * Guard 2: droppables are re-measured during a drag, and auto-scroll
 * only runs at the vertical edges of the scroller.
 * Guard 3: while a drag is on, a refetch or realtime update does not
 * replace the rows; the drag end shows the latest data at once.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DndContext, MeasuringStrategy } from '@dnd-kit/core';
import { describe, expect, it, vi } from 'vitest';
import type { DropCheck } from './workload-assign';
import { DropTd, WORKLOAD_AUTO_SCROLL, WORKLOAD_MEASURING, type DropTarget } from './parts/workload-dnd';
import { WorkloadTray } from './parts/workload-tray';
import {
  BOARD_MOVED_TEXT,
  DROP_TARGET_ATTR,
  dropTargetInStack,
  dropTargetKey,
  handleDrop,
  holdWhileDragging,
  parseDropTargetKey,
  releasePoint,
  resolveDropTarget,
  type DropEffects,
  type Held,
  type HitElement,
} from './workload-drop-guards';

const QA_PRO = 31; // QA Professional, the source row
const ILAY = 17; // Ilay Edri, the wrong target on staging
const MON = '2026-11-30';
const TUE = '2026-12-01';

const cell = (userId: number, day: string): DropTarget => ({ kind: 'cell', userId, day });
const TRAY: DropTarget = { kind: 'tray' };

/** A hit-test element: `host` is the key of the droppable it sits in (null = none). */
const hit = (host: string | null): HitElement => ({
  closest: (selector) => {
    expect(selector).toBe(`[${DROP_TARGET_ATTR}]`);
    return host == null ? null : { getAttribute: (name) => (name === DROP_TARGET_ATTR ? host : null) };
  },
});

const ok = (over: Partial<DropCheck> = {}): DropCheck => ({ ok: true, reason: null, crossDept: false, needsApproval: false, addsToTeam: false, ...over });

function effects() {
  const fx = { boardMoved: vi.fn(), blocked: vi.fn(), submit: vi.fn() } satisfies DropEffects;
  return fx;
}

describe('workload drop guard 1 · target keys', () => {
  it('a person-day key round-trips; the % cell and the lane cell share it', () => {
    expect(dropTargetKey(cell(ILAY, MON))).toBe(`cell:${ILAY}:${MON}`);
    expect(parseDropTargetKey(`cell:${ILAY}:${MON}`)).toEqual(cell(ILAY, MON));
    expect(dropTargetKey(TRAY)).toBe('tray');
    expect(parseDropTargetKey('tray')).toEqual(TRAY);
  });

  it.each([null, undefined, '', 'cell:abc:2026-11-30', 'cell:17:30/11', 'lane:17:2026-11-30', 'cell:17'])('%s is not a target', (key) => {
    expect(parseDropTargetKey(key)).toBeNull();
  });
});

describe('workload drop guard 1 · the target under the pointer (hit-test stack)', () => {
  it('passes over the drag overlay chip (in no droppable) and returns the cell beneath it', () => {
    const stack = [hit(null), hit(null), hit(`cell:${QA_PRO}:${MON}`), hit(`cell:${QA_PRO}:${MON}`), hit(null)];
    expect(dropTargetInStack(stack)).toEqual(cell(QA_PRO, MON));
  });

  it('the tray', () => {
    expect(dropTargetInStack([hit(null), hit('tray')])).toEqual(TRAY);
  });

  it('a pointer over no droppable (the User column, the page) is no target', () => {
    expect(dropTargetInStack([hit(null), hit(null), hit(null)])).toBeNull();
    expect(dropTargetInStack([])).toBeNull();
  });
});

describe('workload drop guard 1 · the release point', () => {
  const activator = { clientX: 400, clientY: 120, timeStamp: 1_000 };

  it('is the document’s last pointer event of this drag', () => {
    expect(releasePoint({ x: 410, y: 128, at: 1_450 }, activator, { x: 0, y: 0 })).toEqual({ x: 410, y: 128 });
  });

  it('dnd-kit’s delta is not used when the pointer was tracked: it includes the scroll since the drag started', () => {
    // The pointer came back to its start while the page scrolled 380 px:
    // delta = pointer move (≈0) + scroll (-380). activator + delta would
    // point 380 px away from the pointer.
    expect(releasePoint({ x: 400, y: 121, at: 1_400 }, activator, { x: 0, y: -379 })).toEqual({ x: 400, y: 121 });
  });

  it('a pointer event from before this drag is stale: falls back to activator + delta', () => {
    expect(releasePoint({ x: 10, y: 10, at: 900 }, activator, { x: 30, y: 52 })).toEqual({ x: 430, y: 172 });
    expect(releasePoint(null, activator, { x: -5, y: 7 })).toEqual({ x: 395, y: 127 });
  });

  it('no coordinates at all (a keyboard activator): null', () => {
    expect(releasePoint(null, { timeStamp: 5 }, { x: 0, y: 0 })).toBeNull();
    expect(releasePoint(null, null, { x: 0, y: 0 })).toBeNull();
  });
});

describe('workload drop guard 1 · resolveDropTarget(over, pointerTarget)', () => {
  it('the same target: over', () => {
    const over = cell(ILAY, MON);
    expect(resolveDropTarget(over, cell(ILAY, MON))).toBe(over);
    expect(resolveDropTarget(TRAY, TRAY)).toBe(TRAY);
  });

  it('the staging case: over says Ilay Edri, the pointer is back on the source cell: null', () => {
    expect(resolveDropTarget(cell(ILAY, MON), cell(QA_PRO, MON))).toBeNull();
  });

  it('another day of the same person, or the tray against a cell: null', () => {
    expect(resolveDropTarget(cell(ILAY, MON), cell(ILAY, TUE))).toBeNull();
    expect(resolveDropTarget(TRAY, cell(ILAY, MON))).toBeNull();
    expect(resolveDropTarget(cell(ILAY, MON), TRAY)).toBeNull();
  });

  it('the pointer over no droppable, or no over: null', () => {
    expect(resolveDropTarget(cell(ILAY, MON), null)).toBeNull();
    expect(resolveDropTarget(null, cell(ILAY, MON))).toBeNull();
    expect(resolveDropTarget(undefined, undefined)).toBeNull();
  });
});

describe('workload drop guard 1 · handleDrop writes only on the target under the pointer', () => {
  const lane = { fromUserId: QA_PRO };

  it('the staging case: nothing is written, the user is told the board moved', () => {
    const fx = effects();
    const checkCell = vi.fn(() => ok({ addsToTeam: true }));
    const out = handleDrop({ source: lane, over: cell(ILAY, MON), pointer: cell(QA_PRO, MON), checkCell }, fx);
    expect(out).toBe('moved');
    expect(fx.boardMoved).toHaveBeenCalledTimes(1);
    expect(fx.submit).not.toHaveBeenCalled();
    expect(checkCell).not.toHaveBeenCalled();
    expect(BOARD_MOVED_TEXT).toBe('The board moved while you were dragging, so nothing was changed. Try again.');
  });

  it('a pointer over no droppable while over is a cell: board moved', () => {
    const fx = effects();
    expect(handleDrop({ source: lane, over: cell(ILAY, MON), pointer: null, checkCell: () => ok() }, fx)).toBe('moved');
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('over and pointer agree: the move is written', () => {
    const fx = effects();
    const check = ok();
    expect(handleDrop({ source: lane, over: cell(ILAY, TUE), pointer: cell(ILAY, TUE), checkCell: () => check }, fx)).toBe('submit');
    expect(fx.submit).toHaveBeenCalledWith({ userId: ILAY, day: TUE }, check);
    expect(fx.boardMoved).not.toHaveBeenCalled();
  });

  it('the tray: unassign, also checked against the pointer', () => {
    const fx = effects();
    expect(handleDrop({ source: lane, over: TRAY, pointer: TRAY, checkCell: () => ok() }, fx)).toBe('submit');
    expect(fx.submit).toHaveBeenCalledWith(null, null);

    const moved = effects();
    expect(handleDrop({ source: lane, over: TRAY, pointer: cell(QA_PRO, MON), checkCell: () => ok() }, moved)).toBe('moved');
    expect(moved.submit).not.toHaveBeenCalled();
  });

  it('an unassigned tray chip on the tray: nothing', () => {
    const fx = effects();
    expect(handleDrop({ source: { fromUserId: null }, over: TRAY, pointer: TRAY, checkCell: () => ok() }, fx)).toBe('none');
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('no over (dropped outside every target): nothing, and no warning', () => {
    const fx = effects();
    expect(handleDrop({ source: lane, over: null, pointer: cell(QA_PRO, MON), checkCell: () => ok() }, fx)).toBe('none');
    expect(fx.boardMoved).not.toHaveBeenCalled();
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('back on the source cell: silent, nothing written', () => {
    const fx = effects();
    const sameCell: DropCheck = { ok: false, reason: 'same-cell', crossDept: false, needsApproval: false, addsToTeam: false };
    expect(handleDrop({ source: lane, over: cell(QA_PRO, MON), pointer: cell(QA_PRO, MON), checkCell: () => sameCell }, fx)).toBe('blocked');
    expect(fx.blocked).not.toHaveBeenCalled();
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('a refused drop warns with its reason', () => {
    const fx = effects();
    const refused: DropCheck = { ok: false, reason: 'service', crossDept: false, needsApproval: false, addsToTeam: false };
    expect(handleDrop({ source: lane, over: cell(ILAY, MON), pointer: cell(ILAY, MON), checkCell: () => refused }, fx)).toBe('blocked');
    expect(fx.blocked).toHaveBeenCalledWith('service', { userId: ILAY, day: MON });
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('a person no longer on the board: nothing', () => {
    const fx = effects();
    expect(handleDrop({ source: lane, over: cell(ILAY, MON), pointer: cell(ILAY, MON), checkCell: () => null }, fx)).toBe('none');
    expect(fx.submit).not.toHaveBeenCalled();
  });

  it('a keyboard drag passes over itself as the pointer target: unchanged behaviour', () => {
    const fx = effects();
    const over = cell(ILAY, TUE);
    expect(handleDrop({ source: lane, over, pointer: over, checkCell: () => ok() }, fx)).toBe('submit');
  });
});

describe('workload drop guard 2 · measuring and auto-scroll of the DndContext', () => {
  it('droppables are re-measured during a drag (numeric frequency), never while idle', () => {
    expect(WORKLOAD_MEASURING.droppable?.strategy).toBe(MeasuringStrategy.WhileDragging);
    expect(typeof WORKLOAD_MEASURING.droppable?.frequency).toBe('number');
    expect(WORKLOAD_MEASURING.droppable?.frequency).toBeLessThanOrEqual(150);
  });

  it('auto-scroll: off on the x axis, only the outer 10% on the y axis, at half speed', () => {
    expect(WORKLOAD_AUTO_SCROLL.enabled).not.toBe(false);
    expect(WORKLOAD_AUTO_SCROLL.threshold).toEqual({ x: 0, y: 0.1 });
    expect(WORKLOAD_AUTO_SCROLL.acceleration).toBe(5);
  });

  it('on an 850 px scroller the band is 85 px: a chip 150 px below the top edge no longer scrolls the page', () => {
    const band = 850 * (WORKLOAD_AUTO_SCROLL.threshold?.y ?? 0.2);
    expect(band).toBe(85);
    expect(150).toBeGreaterThan(band);
    expect(150).toBeLessThan(850 * 0.2); // inside dnd-kit's default 20% band
  });
});

describe('workload drop guard 3 · the board holds still during a drag (holdWhileDragging)', () => {
  type Board = { rows: string[]; refreshing: boolean };
  const before: Board = { rows: ['QA TeamLeader', 'QA Professional'], refreshing: false };
  const refetched: Board = { rows: ['Ilay Edri', 'QA TeamLeader', 'QA Professional'], refreshing: false };

  /** Renders in sequence, carrying the held value like the hook's ref does. */
  function run(frames: Array<{ live: Board; dragging: boolean }>) {
    let held: Held<Board> = null;
    return frames.map(({ live, dragging }) => {
      const next = holdWhileDragging(held, live, dragging);
      held = next.held;
      return next.value;
    });
  }

  it('no drag: the live data, nothing held', () => {
    expect(holdWhileDragging(null, before, false)).toEqual({ held: null, value: before });
  });

  it('a refetch (or realtime invalidation) that lands mid-drag does not replace the rows', () => {
    const shown = run([
      { live: before, dragging: false },
      { live: before, dragging: true }, // onDragStart
      { live: { ...before, refreshing: true }, dragging: true }, // realtime invalidation: refetch starts
      { live: refetched, dragging: true }, // the new rows arrive under the pointer
    ]);
    expect(shown[1]).toBe(before);
    expect(shown[2]).toBe(before);
    expect(shown[3]).toBe(before);
  });

  it('the drag ends: the latest data is shown at once (one flush)', () => {
    const shown = run([
      { live: before, dragging: true },
      { live: refetched, dragging: true },
      { live: refetched, dragging: false }, // onDragEnd / onDragCancel
    ]);
    expect(shown[1]).toBe(before);
    expect(shown[2]).toBe(refetched);
  });

  it('the next drag holds the data of ITS start, not of the previous drag', () => {
    const shown = run([
      { live: before, dragging: true },
      { live: before, dragging: false },
      { live: refetched, dragging: false },
      { live: refetched, dragging: true },
      { live: before, dragging: true },
    ]);
    expect(shown[3]).toBe(refetched);
    expect(shown[4]).toBe(refetched);
  });

  it('holds undefined too (a query with no data yet stays empty for the whole drag)', () => {
    const { held, value } = holdWhileDragging<Board | undefined>(null, undefined, true);
    expect(value).toBeUndefined();
    expect(holdWhileDragging(held, refetched, true).value).toBeUndefined();
  });
});

describe('workload drop guard 1 · the droppables carry their target in the markup', () => {
  it('a day cell: data-drop-target="cell:<userId>:<day>"', () => {
    const html = renderToStaticMarkup(
      createElement(
        DndContext,
        null,
        createElement('table', null, createElement('tbody', null, createElement('tr', null, createElement(DropTd, { id: `lane:${ILAY}:${MON}`, target: cell(ILAY, MON), children: 'x' })))),
      ),
    );
    expect(html).toContain(`<td ${DROP_TARGET_ATTR}="cell:${ILAY}:${MON}"`);
  });

  it('the tray drop zone: data-drop-target="tray"', () => {
    const html = renderToStaticMarkup(
      createElement(
        DndContext,
        null,
        createElement(WorkloadTray, {
          tray: undefined,
          trayLoading: false,
          trayError: false,
          onRetry: () => {},
          overload: [],
          tasks: {},
          peopleById: new Map(),
          canDrag: () => false,
          active: null,
          approvalsCount: 0,
          onOpenTask: () => {},
          onApprove: () => {},
          onReject: () => {},
          deciding: null,
        }),
      ),
    );
    const tag = html.match(/<div[^>]*data-testid="workload-tray"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain(`${DROP_TARGET_ATTR}="tray"`);
  });
});
