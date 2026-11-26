/**
 * QA6 round 2 (26.11) · finding 1: starting a drag on the Workload board
 * must not change any row's height (the cell under the pointer moved
 * ~53 px on staging because each blocked row grew a reason line).
 *
 * The specs run in node (no jsdom, and jsdom has no layout engine
 * anyway), so they prove it structurally: the markup that takes part in
 * layout is IDENTICAL before and during a drag, and everything a drag
 * adds is absolutely positioned inside a fixed-height or relative box.
 *   - Person cell: the second line (h-4) is always there; the reason is
 *     an `absolute` badge over it, and the text under it only turns
 *     `invisible` (which keeps its box).
 *   - Day cell: the before/after preview is an `absolute inset-[2px]`
 *     overlay that clips its text (`overflow-hidden`).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CellPreview, PersonSubline, WorkloadPersonCell, type RowReason } from './workload-drag-feedback';

const person = (reason: RowReason | null, subtitle: string | null = 'BIM Coordinator · QA Team') =>
  renderToStaticMarkup(createElement(WorkloadPersonCell, { initials: 'QT', name: 'QA TeamLeader', subtitle, reason }));

/** The class list of the element carrying `data-testid`. */
function classOf(html: string, testId: string): string[] {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element with data-testid="${testId}"`);
  return (tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
}

/**
 * The part of the markup that takes part in layout: drop the drag-only
 * absolute badge, and the `invisible` class (visibility keeps the box).
 */
function inFlow(html: string): string {
  return html
    .replace(/<span data-testid="workload-row-reason"[^>]*>[^<]*<\/span>/g, '')
    .replace(/ invisible(?=[" ])/g, '');
}

const REASONS: RowReason[] = [
  { tone: 'blocked', text: 'Does not provide BIM Coordination' },
  { tone: 'blocked', text: 'Not on the project team' },
  { tone: 'approval', text: 'Needs approval' },
  { tone: 'team', text: 'Joins the project team' },
];

describe('Workload drag feedback · rows keep their height (round 2, finding 1)', () => {
  it.each(REASONS)('a "$text" reason leaves the in-flow markup of the person cell unchanged', (reason) => {
    const idle = person(null);
    const dragging = person(reason);
    expect(dragging).toContain(reason.text);
    expect(idle).not.toContain(reason.text);
    expect(inFlow(dragging)).toBe(idle);
  });

  it('the reason is an absolutely positioned badge, clipped to the line, that takes no pointer events', () => {
    const cls = classOf(person(REASONS[0]), 'workload-row-reason');
    expect(cls).toEqual(expect.arrayContaining(['absolute', 'inset-y-0', 'left-0', 'max-w-full', 'truncate', 'pointer-events-none', 'leading-4']));
  });

  it('the second line is a fixed-height (h-4) relative box, idle and dragging alike', () => {
    for (const html of [person(null), person(REASONS[0])]) {
      expect(classOf(html, 'workload-person-subline')).toEqual(expect.arrayContaining(['relative', 'h-4']));
    }
  });

  it('a person with no position or org unit still gets the reserved line, so his row does not grow either', () => {
    const idle = person(null, null);
    expect(classOf(idle, 'workload-person-subline')).toEqual(expect.arrayContaining(['relative', 'h-4']));
    expect(inFlow(person(REASONS[0], null))).toBe(idle);
  });

  it('only the reason badge is added: one extra element, nothing else changes', () => {
    const idle = renderToStaticMarkup(createElement(PersonSubline, { subtitle: 'Engineer', reason: null }));
    const dragging = renderToStaticMarkup(createElement(PersonSubline, { subtitle: 'Engineer', reason: REASONS[2] }));
    const tags = (h: string) => (h.match(/<[a-z]+/g) ?? []).length;
    expect(tags(dragging)).toBe(tags(idle) + 1);
  });
});

describe('Workload drag feedback · the day-cell preview is an overlay (round 2, finding 1)', () => {
  const OVERLAY = ['absolute', 'inset-[2px]', 'overflow-hidden', 'pointer-events-none', 'z-10'];

  it('the "Now" marker is an absolute overlay', () => {
    expect(classOf(renderToStaticMarkup(createElement(CellPreview, { variant: 'now' })), 'workload-cell-preview')).toEqual(
      expect.arrayContaining(OVERLAY),
    );
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('the before→after preview (over=%s, bad=%s) is an absolute overlay', (isOver, bad) => {
    const html = renderToStaticMarkup(createElement(CellPreview, { variant: 'preview', isOver, bad, children: '40→65%' }));
    expect(classOf(html, 'workload-cell-preview')).toEqual(expect.arrayContaining(OVERLAY));
    expect(html).toContain('40→65%');
  });

  it('a long reason stays inside the clipped overlay (it cannot widen or heighten the cell)', () => {
    const long = createElement('span', { className: 'font-sans text-[9px]' }, 'Does not provide BIM Coordination');
    const html = renderToStaticMarkup(createElement(CellPreview, { variant: 'preview', isOver: true, bad: true, children: long }));
    // One root, and the reason is its child.
    expect(html.startsWith('<div data-testid="workload-cell-preview"')).toBe(true);
    expect(html.endsWith('</span></div>')).toBe(true);
    expect(classOf(html, 'workload-cell-preview')).toEqual(expect.arrayContaining(OVERLAY));
  });
});
