import { useEffect, useRef } from 'react';
import type { DragSource, DropCheck, DropReason } from './workload-assign';
import type { DropTarget } from './parts/workload-dnd';

/**
 * QA6 round 3 (26.11): safety guards of the Workload drag-and-drop.
 *
 * On staging (Admin session) a drag of chip QA6-W5 that was put back
 * where it started was resolved as a drop on Ilay Edri, Mon 30/11: the
 * board had moved about 380 px during the drag. The task was reassigned
 * and, the actor being an Admin, Ilay was silently added to the project
 * Team.
 *
 *  1. A pointer drop lands only on the cell that is under the pointer
 *     when it is released (resolveDropTarget / handleDrop).
 *  2. Droppables are re-measured while dragging and auto-scroll is kept
 *     to the scroller's edges: the DndContext config in parts/workload-dnd.tsx.
 *  3. The board data holds still while a drag is on (holdWhileDragging).
 */

// ─── Guard 1 · the target is the cell under the pointer ─────────────────

/** Every droppable carries its target as `data-drop-target`: "tray" or "cell:<userId>:<yyyy-mm-dd>". */
export const DROP_TARGET_ATTR = 'data-drop-target';

export const BOARD_MOVED_TEXT = 'The board moved while you were dragging, so nothing was changed. Try again.';

/** The `data-drop-target` value of a target. The % cell and the lane cell of a person-day share it. */
export function dropTargetKey(target: DropTarget): string {
  return target.kind === 'tray' ? 'tray' : `cell:${target.userId}:${target.day}`;
}

const CELL_KEY = /^cell:(\d+):(\d{4}-\d{2}-\d{2})$/;

export function parseDropTargetKey(key: string | null | undefined): DropTarget | null {
  if (key === 'tray') return { kind: 'tray' };
  const m = key ? CELL_KEY.exec(key) : null;
  return m ? { kind: 'cell', userId: Number(m[1]), day: m[2] } : null;
}

/** What `document.elementsFromPoint` returns, as far as the guard reads it. */
export type HitElement = { closest(selector: string): { getAttribute(name: string): string | null } | null };

/**
 * The drop target under the pointer, from the hit-test stack (topmost
 * first): the first element that sits inside a droppable. The drag
 * overlay (the chip under the pointer) and other floating layers sit in
 * none and are passed over; that is why the stack is read and not only
 * `elementFromPoint`, which always returns the overlay chip.
 */
export function dropTargetInStack(stack: Iterable<HitElement>): DropTarget | null {
  for (const el of stack) {
    const host = el.closest(`[${DROP_TARGET_ATTR}]`);
    if (host) return parseDropTargetKey(host.getAttribute(DROP_TARGET_ATTR));
  }
  return null;
}

export type Point = { x: number; y: number };
/** The last pointer event the document saw (client coordinates, `timeStamp`). */
export type TrackedPointer = Point & { at: number };

/**
 * Where a pointer drag was released, in client coordinates.
 *
 * The document's own last pointer event (pointerup, else the last
 * pointermove) is the truth. dnd-kit 6.3's `DragEndEvent.delta` is not a
 * pure pointer delta: it also adds how far the scrollable ancestors
 * scrolled since the drag started, so after any scroll the activator's
 * client point plus `delta` is somewhere else on the screen. It is only
 * the fallback when no pointer event of this drag was seen.
 */
export function releasePoint(
  tracked: TrackedPointer | null | undefined,
  activator: { clientX?: number; clientY?: number; timeStamp?: number } | null | undefined,
  delta: Point,
): Point | null {
  const startedAt = typeof activator?.timeStamp === 'number' ? activator.timeStamp : Number.NEGATIVE_INFINITY;
  if (tracked && tracked.at >= startedAt && Number.isFinite(tracked.x) && Number.isFinite(tracked.y)) {
    return { x: tracked.x, y: tracked.y };
  }
  const x = activator?.clientX;
  const y = activator?.clientY;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x: x + delta.x, y: y + delta.y };
}

/** The drop target under a client point on the page (null outside every droppable). */
export function dropTargetAtPoint(point: Point | null): DropTarget | null {
  if (!point || typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
  return dropTargetInStack(document.elementsFromPoint(point.x, point.y));
}

/**
 * The target a drop may act on: dnd-kit's `over`, only when it is the
 * same target as the one under the pointer. Anything else (the pointer
 * over another cell, or over no droppable) means the board moved under
 * the drag after dnd-kit measured it: null, nothing changes.
 */
export function resolveDropTarget(over: DropTarget | null | undefined, pointerTarget: DropTarget | null | undefined): DropTarget | null {
  if (!over || !pointerTarget) return null;
  return dropTargetKey(over) === dropTargetKey(pointerTarget) ? over : null;
}

export type CellTarget = { userId: number; day: string };

export type DropEffects = {
  /** The pointer was not over `over`: warn (BOARD_MOVED_TEXT), change nothing. */
  boardMoved(): void;
  /** The rules refuse the drop (same cell is silent and never reaches this). */
  blocked(reason: DropReason, target: CellTarget): void;
  /** Write the move: a cell, or null for the tray (unassign). */
  submit(target: CellTarget | null, check: DropCheck | null): void;
};

export type DropOutcome = 'none' | 'moved' | 'blocked' | 'submit';

/**
 * What a drop does, before anything is written.
 *  - No `over`: nothing (a drop outside every target, or on the tray with
 *    an unassigned chip, whose tray target is disabled).
 *  - `pointer` is the target under the released pointer (pass `over`
 *    itself for a keyboard drag, which has no pointer). When it is not
 *    `over`: boardMoved, nothing written.
 *  - Tray: unassign, for a chip that belongs to someone.
 *  - A cell: `checkCell` (null when the person is not on the board) must
 *    allow it; a refusal warns, the same cell is silent.
 */
export function handleDrop(
  input: {
    source: Pick<DragSource, 'fromUserId'>;
    over: DropTarget | null | undefined;
    pointer: DropTarget | null | undefined;
    checkCell: (target: CellTarget) => DropCheck | null;
  },
  fx: DropEffects,
): DropOutcome {
  if (!input.over) return 'none';
  const target = resolveDropTarget(input.over, input.pointer);
  if (!target) {
    fx.boardMoved();
    return 'moved';
  }
  if (target.kind === 'tray') {
    if (input.source.fromUserId == null) return 'none';
    fx.submit(null, null);
    return 'submit';
  }
  const cell: CellTarget = { userId: target.userId, day: target.day };
  const check = input.checkCell(cell);
  if (!check) return 'none';
  if (!check.ok) {
    if (check.reason && check.reason !== 'same-cell') fx.blocked(check.reason, cell);
    return 'blocked';
  }
  fx.submit(cell, check);
  return 'submit';
}

// ─── Guard 3 · the board holds still during a drag ──────────────────────

export type Held<T> = { value: T } | null;

/**
 * The gate. While a drag is on, the board keeps showing (and checking
 * against) what it showed when the drag started: a background refetch, a
 * realtime invalidation or a notification may update the query cache,
 * but rows, tray, error banner and "Refreshing…" do not change under the
 * pointer. When the drag ends the live value comes back at once, so
 * whatever arrived meanwhile is applied in one go.
 */
export function holdWhileDragging<T>(held: Held<T>, live: T, dragging: boolean): { held: Held<T>; value: T } {
  if (!dragging) return { held: null, value: live };
  const h = held ?? { value: live };
  return { held: h, value: h.value };
}

/** `holdWhileDragging` across renders. */
export function useHoldWhileDragging<T>(live: T, dragging: boolean): T {
  const ref = useRef<Held<T>>(null);
  const next = holdWhileDragging(ref.current, live, dragging);
  ref.current = next.held;
  return next.value;
}

/**
 * The document's last pointer event, kept for the drop check. Capture
 * phase on the document: it runs before dnd-kit's own (bubble) pointerup
 * listener, so onDragEnd reads the release point itself.
 */
export function useLastPointer(): { readonly current: TrackedPointer | null } {
  const ref = useRef<TrackedPointer | null>(null);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const p = ref.current ?? (ref.current = { x: 0, y: 0, at: 0 });
      p.x = e.clientX;
      p.y = e.clientY;
      p.at = e.timeStamp;
    };
    const types = ['pointerdown', 'pointermove', 'pointerup'] as const;
    for (const t of types) document.addEventListener(t, onPointer, { capture: true, passive: true });
    return () => {
      for (const t of types) document.removeEventListener(t, onPointer, { capture: true });
    };
  }, []);
  return ref;
}
