import { describe, it, expect, vi } from 'vitest';
import { createPickedMenuFocus } from './menu-focus';

// QA6 PR-071 — the Add menus moved to Radix DropdownMenu. Radix hands
// focus back to the trigger on close; after a pick that would steal it
// from the inline form / picker the item just opened.
describe('createPickedMenuFocus', () => {
  const closeEvent = () => ({ preventDefault: vi.fn() });

  it('lets Radix return focus to the trigger when nothing was picked (Escape / outside click)', () => {
    const h = createPickedMenuFocus();
    const e = closeEvent();
    h.onCloseAutoFocus(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('skips the hand-back once after an item was picked', () => {
    const h = createPickedMenuFocus();
    h.markPicked();
    const e = closeEvent();
    h.onCloseAutoFocus(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('resets after one close, so the next Escape returns focus again', () => {
    const h = createPickedMenuFocus();
    h.markPicked();
    h.onCloseAutoFocus(closeEvent());
    const next = closeEvent();
    h.onCloseAutoFocus(next);
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps separate state per menu instance', () => {
    const a = createPickedMenuFocus();
    const b = createPickedMenuFocus();
    a.markPicked();
    const eb = closeEvent();
    b.onCloseAutoFocus(eb);
    expect(eb.preventDefault).not.toHaveBeenCalled();
  });
});
