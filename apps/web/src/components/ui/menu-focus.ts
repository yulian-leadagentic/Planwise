/**
 * Focus hand-off for DropdownMenus whose items open something that takes
 * focus itself (a picker modal, an inline form with an autoFocus input).
 *
 * Radix returns focus to the trigger when a menu closes. That runs after
 * the close animation, so it would steal focus back from the input the
 * picked item just mounted. Call `markPicked()` in the item's onSelect and
 * pass `onCloseAutoFocus` to DropdownMenuContent: after a pick the
 * hand-back is skipped once, while Escape and an outside click still
 * return focus to the trigger as usual.
 *
 * Framework-free on purpose so it can be unit-tested without a DOM.
 */
export interface PickedMenuFocus {
  markPicked: () => void;
  onCloseAutoFocus: (e: Pick<Event, 'preventDefault'>) => void;
}

export function createPickedMenuFocus(): PickedMenuFocus {
  let picked = false;
  return {
    markPicked: () => {
      picked = true;
    },
    onCloseAutoFocus: (e) => {
      if (!picked) return;
      e.preventDefault();
      picked = false;
    },
  };
}
