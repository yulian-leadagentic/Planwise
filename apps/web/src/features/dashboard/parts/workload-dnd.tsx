import type { ReactNode, TdHTMLAttributes } from 'react';
import {
  KeyboardCode,
  MeasuringStrategy,
  closestCenter,
  closestCorners,
  pointerWithin,
  useDraggable,
  useDroppable,
  type AutoScrollOptions,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type MeasuringConfiguration,
} from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import type { DragSource } from '../workload-assign';
import type { WorkloadTaskEntry } from '../workload-contract';
import { dropTargetKey } from '../workload-drop-guards';
import { TaskChip, type ChipView } from './workload-chip';

/**
 * QA6 P4 (PR-063): the @dnd-kit pieces of the Workload board. A chip is
 * a draggable; every person-day (the % cell and the lane cell) and the
 * tray are droppables. Pointer drags drop only where the pointer is;
 * keyboard drags (Space to lift, arrows to move between cells, Space to
 * drop, Escape to cancel) jump from cell to cell.
 */

export type DropTarget = { kind: 'cell'; userId: number; day: string } | { kind: 'tray' };
export type DragData = { source: DragSource; task: WorkloadTaskEntry };

export const dragId = (s: DragSource) => `chip:${s.origin}:${s.taskId}:${s.fromUserId ?? 'none'}:${s.fromDay ?? 'none'}`;

/**
 * Round 3 (26.11) · re-measure the droppables while dragging.
 *
 * dnd-kit 6.3's default (strategy WhileDragging, frequency "optimized")
 * measures every droppable once when a drag starts, and again only when
 * the set of droppables changes. Scroll is covered without re-measuring:
 * a droppable's rect subtracts the scroll of its scrollable ancestors
 * each time it is read. A layout shift that is not a scroll (something
 * above the board growing or shrinking) is not covered, so `over` could
 * stay on the cell that USED to be under the pointer. `Always` alone does
 * not fix that: it only adds measuring before a drag (every droppable, on
 * every change, while idle). A numeric frequency does: every droppable is
 * re-measured at most every 100 ms while the pointer moves, and only
 * during a drag. A shift under a still pointer is caught by the drop
 * check (guard 1).
 */
export const WORKLOAD_MEASURING: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.WhileDragging, frequency: 100 },
};

/**
 * Round 3 (26.11) · auto-scroll only at the scroller's edges.
 *
 * The default scrolls a container once the pointer is within 20% of its
 * edge, at up to 10 px every 5 ms. Here the vertical scroller is the
 * app's <main> (about 850 px tall on a laptop), so the top and bottom
 * 170 px of the visible board were scroll bands, and the table's own
 * horizontal scroller (overflow-x-auto) had 20% bands over its first and
 * last columns. A chip picked up inside the top band scrolls the page as
 * soon as the pointer moves up at all, at about 1 px per ms halfway into
 * the band, which fits the 380 px in 400 ms measured on staging.
 *   - x: 0 turns horizontal auto-scroll off: day columns never slide under
 *     the pointer (shift + wheel still scrolls the table).
 *   - y: 0.1 keeps vertical auto-scroll for long boards, within 10% of the
 *     top / bottom edge only (about 85 px).
 *   - acceleration 5 halves the speed (at most 1000 px/s at the very edge).
 */
export const WORKLOAD_AUTO_SCROLL: AutoScrollOptions = {
  threshold: { x: 0, y: 0.1 },
  acceleration: 5,
};

/** Pointer: the droppable under the pointer, or none. Keyboard: the closest one. */
export const workloadCollision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

const DIRECTIONS: string[] = [KeyboardCode.Down, KeyboardCode.Up, KeyboardCode.Left, KeyboardCode.Right];

/** Arrow keys move the dragged chip to the nearest enabled cell in that direction. */
export const workloadKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (!DIRECTIONS.includes(event.code)) return undefined;
  event.preventDefault();
  const { active, collisionRect, droppableRects, droppableContainers, over } = context;
  if (!active || !collisionRect) return undefined;
  const candidates: DroppableContainer[] = [];
  droppableContainers.getEnabled().forEach((entry) => {
    if (!entry || entry.disabled) return;
    const rect = droppableRects.get(entry.id);
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ax = collisionRect.left + collisionRect.width / 2;
    const ay = collisionRect.top + collisionRect.height / 2;
    if (
      (event.code === KeyboardCode.Down && cy > ay + 2) ||
      (event.code === KeyboardCode.Up && cy < ay - 2) ||
      (event.code === KeyboardCode.Right && cx > ax + 2) ||
      (event.code === KeyboardCode.Left && cx < ax - 2)
    ) {
      candidates.push(entry);
    }
  });
  const collisions = closestCorners({ active, collisionRect, droppableRects, droppableContainers: candidates, pointerCoordinates: null });
  let next = collisions[0]?.id;
  if (next != null && next === over?.id && collisions.length > 1) next = collisions[1].id;
  const rect = next != null ? droppableRects.get(next) : null;
  if (!rect) return undefined;
  return {
    x: rect.left + (rect.width - collisionRect.width) / 2,
    y: rect.top + (rect.height - collisionRect.height) / 2,
  };
};

/** A chip the caller may (or may not) pick up. A click opens the task. */
export function DraggableChip({
  source,
  task,
  view,
  canDrag,
  sibling,
  title,
  onOpen,
  layout,
}: {
  source: DragSource;
  task: WorkloadTaskEntry | null;
  view: ChipView;
  canDrag: boolean;
  sibling?: boolean;
  title?: string;
  onOpen?: () => void;
  layout?: 'inline' | 'stack';
}) {
  const data: DragData | undefined = task ? { source, task } : undefined;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragId(source), data, disabled: !canDrag || !task });
  const live = canDrag && !!task;
  return (
    <TaskChip
      ref={setNodeRef}
      {...view}
      layout={layout}
      {...(live ? attributes : {})}
      {...(live ? listeners : {})}
      draggable={live}
      sibling={sibling}
      ghost={isDragging}
      title={title}
      aria-label={live ? `${view.code ?? ''} ${view.name}, ${view.hours}h. Press Space to move.`.trim() : undefined}
      onClick={onOpen && !view.masked ? onOpen : undefined}
      className={cn(onOpen && !view.masked && !live && 'cursor-pointer hover:border-slate-300 dark:hover:border-slate-600')}
    />
  );
}

/**
 * A table cell that accepts a chip. It carries its target as
 * `data-drop-target` (dropTargetKey), so a drop can check that the cell
 * under the released pointer is the one dnd-kit resolved (round 3).
 */
export function DropTd({
  id,
  target,
  disabled,
  overClassName,
  className,
  children,
  ...td
}: {
  id: string;
  target: DropTarget;
  disabled?: boolean;
  overClassName?: string;
  children: ReactNode | ((isOver: boolean) => ReactNode);
} & Omit<TdHTMLAttributes<HTMLTableCellElement>, 'children'>) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { target }, disabled });
  const over = isOver && !disabled;
  return (
    <td ref={setNodeRef} data-drop-target={dropTargetKey(target)} className={cn(className, over && overClassName)} {...td}>
      {typeof children === 'function' ? children(over) : children}
    </td>
  );
}
