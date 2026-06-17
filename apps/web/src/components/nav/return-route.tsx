import { ChevronLeft } from 'lucide-react';
import {
  Link,
  type LinkProps,
  type To,
  useLocation,
  useNavigate,
} from 'react-router-dom';

/**
 * App-wide "return to where I came from" navigation primitive.
 *
 * Problem solved
 * --------------
 * Many flows in this app drill from one entity into another (task → project,
 * project → contact, report row → underlying object, …). Today the destination
 * has no idea where the user came from, so the user has to retrace by hand.
 *
 * How it works
 * ------------
 * Every cross-entity navigation stamps `state.return = { to, label }` onto
 * the React Router history entry. The destination renders a sticky
 * `<ReturnPill/>` (mounted once in AppShell) that says "← Back to {label}"
 * and clicking it navigates to the recorded URL.
 *
 * For drawers/modals whose selection lives in component state, the host page
 * must also URL-encode that selection (see useDrawerRoute) — otherwise the
 * recorded "to" URL won't actually restore the drawer.
 *
 * Chain depth
 * -----------
 * This first cut does NOT propagate prior state, so the pill only points back
 * one hop. Combined with URL-encoded drawer state, browser-back covers
 * multi-hop chains. We can upgrade to a propagated chain later if needed.
 */
export interface ReturnState {
  to: string;
  label: string;
}

interface LocationStateShape {
  return?: ReturnState;
}

/** Read the return descriptor (if any) stamped onto the current history entry. */
export function useCurrentReturn(): ReturnState | null {
  const loc = useLocation();
  const st = loc.state as LocationStateShape | null;
  return st?.return ?? null;
}

/**
 * Returns a builder that wraps the current URL into a `state.return` payload.
 * Use when you want to imperatively navigate to a deeper screen and still
 * give the user a way back.
 */
export function useReturnBuilder() {
  const loc = useLocation();
  return (label: string): LocationStateShape => ({
    return: { to: loc.pathname + loc.search, label },
  });
}

/** Imperative variant: navigate(to) but stamp the return so destination can offer "back". */
export function useNavigateWithReturn() {
  const navigate = useNavigate();
  const build = useReturnBuilder();
  return (to: To, returnLabel: string) =>
    navigate(to, { state: build(returnLabel) });
}

interface NavLinkWithReturnProps extends Omit<LinkProps, 'state'> {
  /** Label shown on the destination's "← Back to {label}" pill. */
  returnLabel: string;
}

/**
 * Drop-in replacement for <Link> for cross-entity navigation. Stamps the
 * current URL onto the destination's history entry so the ReturnPill can
 * offer a one-click way back.
 */
export function NavLinkWithReturn({
  returnLabel,
  to,
  ...rest
}: NavLinkWithReturnProps) {
  const build = useReturnBuilder();
  return <Link to={to} state={build(returnLabel)} {...rest} />;
}

/**
 * Sticky "← Back to {label}" pill. Mount once in AppShell; renders null when
 * the current history entry carries no return state, so it costs nothing on
 * pages reached directly.
 */
export function ReturnPill() {
  const ret = useCurrentReturn();
  const navigate = useNavigate();
  if (!ret) return null;
  return (
    <div className="border-b border-blue-100 bg-blue-50/40 px-4 py-1.5 sm:px-5">
      <button
        type="button"
        onClick={() => navigate(ret.to)}
        className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-white text-[12px] font-semibold text-blue-700 hover:bg-blue-100 hover:border-blue-300 px-3 py-1 transition-colors"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to {ret.label}
      </button>
    </div>
  );
}
