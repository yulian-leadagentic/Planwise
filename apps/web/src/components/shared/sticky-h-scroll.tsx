import { useCallback, useEffect, useRef } from 'react';

/**
 * Hook that turns any `overflow-x-auto` container into a TABLE WHOSE
 * HORIZONTAL SCROLLBAR FOLLOWS THE VIEWPORT BOTTOM.
 *
 * Problem this solves: on a tall table (e.g. Execution Board Matrix with
 * dozens of zones), the native horizontal scrollbar lives at the bottom
 * of the table's overflow box — which is far below the viewport. Users
 * had to scroll the page all the way down just to reach the scrollbar,
 * then back up to keep working. Reported 2026-06-22.
 *
 * Usage — one-line change per table:
 *
 *     <div className="rounded-[14px] border ... overflow-x-auto">
 *       <table>…</table>
 *     </div>
 *
 *   becomes:
 *
 *     <div ref={useStickyHScroll()} className="rounded-[14px] border ... overflow-x-auto">
 *       <table>…</table>
 *     </div>
 *
 * No other layout changes. The hook attaches a thin proxy scrollbar to
 * the document body, positioned `fixed` at viewport-bottom, but only
 * while the target container is intersecting the viewport. Scroll
 * events on either side are mirrored, so dragging the proxy moves the
 * content and vice versa.
 *
 * Using fixed-positioning + IntersectionObserver instead of CSS `sticky`
 * because the table containers usually sit inside several overflow-y
 * scrollers (the AppShell main column), which clip a sticky element.
 * `position: fixed` ignores those.
 */
export function useStickyHScroll() {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const proxyRef = useRef<HTMLDivElement | null>(null);
  const phantomRef = useRef<HTMLDivElement | null>(null);
  // Refs used inside event handlers — keeping them refs (not state) avoids
  // re-running the callback ref each render, which would re-create the
  // proxy DOM nodes and lose scrollLeft.
  const syncingRef = useRef(false);

  // The callback ref runs whenever React mounts/unmounts the target.
  // We set up the proxy bar lazily here so consumers don't need to also
  // think about effect lifecycle.
  const setTargetRef = useCallback((el: HTMLDivElement | null) => {
    // Tear down any prior proxy when the element changes (e.g. tab swap
    // unmounts the table). Otherwise the document would accumulate
    // orphaned bars.
    if (proxyRef.current) {
      proxyRef.current.remove();
      proxyRef.current = null;
      phantomRef.current = null;
    }
    targetRef.current = el;
    if (!el) return;

    // Build the floating proxy bar. Inline styles instead of Tailwind so
    // the helper has zero CSS dependencies on the consuming app.
    const proxy = document.createElement('div');
    proxy.setAttribute('aria-hidden', 'true');
    proxy.style.position = 'fixed';
    proxy.style.left = '0';
    proxy.style.right = '0';
    proxy.style.bottom = '0';
    proxy.style.overflowX = 'auto';
    proxy.style.zIndex = '40';
    proxy.style.background = 'rgba(241, 245, 249, 0.95)'; // slate-100 @ 95%
    proxy.style.boxShadow = '0 -1px 0 rgba(15, 23, 42, 0.08)';
    proxy.style.display = 'none'; // hidden until we confirm we need it
    proxy.style.pointerEvents = 'auto';

    const phantom = document.createElement('div');
    // 1px tall so the proxy only shows its native scrollbar — no real
    // content visible inside.
    phantom.style.height = '1px';
    proxy.appendChild(phantom);
    document.body.appendChild(proxy);
    proxyRef.current = proxy;
    phantomRef.current = phantom;

    // Mirror the target's scroll content width onto the proxy's phantom
    // so the scrollbar covers the same horizontal range.
    const recomputeSize = () => {
      const t = targetRef.current;
      const p = proxyRef.current;
      const ph = phantomRef.current;
      if (!t || !p || !ph) return;
      ph.style.width = `${t.scrollWidth}px`;
      // The proxy itself is set to the visible width of the target —
      // mirrors how much of the table is currently on screen, so the
      // scrollbar handle is proportional. Left-aligned to the target's
      // left edge so the bar sits visually under the same content.
      const rect = t.getBoundingClientRect();
      p.style.left = `${rect.left}px`;
      p.style.width = `${rect.width}px`;
      p.style.right = ''; // computed left+width supersedes the initial 0/0
    };
    recomputeSize();

    // Scroll-event mirroring. The syncing flag prevents the two
    // listeners from ping-ponging forever when each one writes the
    // other's scrollLeft.
    const onTargetScroll = () => {
      const p = proxyRef.current;
      if (!p || syncingRef.current) return;
      syncingRef.current = true;
      p.scrollLeft = el.scrollLeft;
      requestAnimationFrame(() => { syncingRef.current = false; });
    };
    const onProxyScroll = () => {
      const t = targetRef.current;
      if (!t || syncingRef.current) return;
      syncingRef.current = true;
      t.scrollLeft = proxy.scrollLeft;
      requestAnimationFrame(() => { syncingRef.current = false; });
    };
    el.addEventListener('scroll', onTargetScroll, { passive: true });
    proxy.addEventListener('scroll', onProxyScroll, { passive: true });

    // Only display the bar when the target is on screen AND actually
    // overflows. IntersectionObserver handles the on-screen check;
    // ResizeObserver re-checks overflow + layout when columns or
    // rows change.
    const updateVisibility = () => {
      const t = targetRef.current;
      const p = proxyRef.current;
      if (!t || !p) return;
      const hasOverflow = t.scrollWidth > t.clientWidth + 1;
      const rect = t.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
      // The user only benefits from the proxy when the table's NATIVE
      // scrollbar is BELOW the viewport. If the whole table fits on
      // screen (bottom < innerHeight), the native bar is already
      // visible — skip the proxy.
      const nativeOffscreen = rect.bottom > window.innerHeight;
      p.style.display = hasOverflow && onScreen && nativeOffscreen ? 'block' : 'none';
      recomputeSize();
    };
    updateVisibility();

    const io = new IntersectionObserver(updateVisibility, { threshold: [0, 1] });
    io.observe(el);
    const ro = new ResizeObserver(updateVisibility);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild as Element);

    // ResizeObserver only fires on border-box changes; it MISSES the
    // case where the container stays the same width but its inner
    // content GROWS wider (e.g. user expands a Planning zone — task
    // rows materialise with min-width 1280px). Watch DOM mutations
    // (subtree class/style/childList) and re-evaluate overflow. Cheap
    // because updateVisibility just reads getBoundingClientRect +
    // scrollWidth — no layout thrash beyond what's already happening.
    // (T2.fix2 follow-up, 2026-06-29.)
    const mo = new MutationObserver(() => updateVisibility());
    mo.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    // Also react to page scroll + window resize — both change which
    // part of the table is on screen.
    const onPageScroll = () => updateVisibility();
    window.addEventListener('scroll', onPageScroll, { passive: true });
    window.addEventListener('resize', updateVisibility);

    // Store cleanup so the next callback-ref invocation can tear down
    // the listeners. Attached to the element so it survives strict-
    // mode double-invocation.
    (el as any).__stickyHScrollCleanup = () => {
      el.removeEventListener('scroll', onTargetScroll);
      proxy.removeEventListener('scroll', onProxyScroll);
      window.removeEventListener('scroll', onPageScroll);
      window.removeEventListener('resize', updateVisibility);
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
      proxy.remove();
    };
  }, []);

  // Final teardown when the consuming component unmounts.
  useEffect(() => {
    return () => {
      const t = targetRef.current as any;
      if (t?.__stickyHScrollCleanup) t.__stickyHScrollCleanup();
    };
  }, []);

  return setTargetRef;
}
