/**
 * Static lookup tables for the Execution Board's visual styling.
 * Extracted from execution-board-page.tsx verbatim.
 */

// `bg` is the solid background-color form of `border` — used to paint the
// colored left-accent stripe via an absolute-positioned overlay span on
// the sticky Zone TD. Chrome / Edge / Safari all drop the `border-left`
// on a `position: sticky` cell inside a `border-collapse: collapse`
// table the moment the user scrolls the table horizontally; the overlay
// avoids that quirk and renders consistently regardless of scrollLeft.
// (T2.fix4, 2026-06-29.)
export const ZONE_COLORS: Record<string, { border: string; bg: string; badge: string }> = {
  zone:     { border: 'border-l-blue-400',   bg: 'bg-blue-400',   badge: 'bg-blue-100 text-blue-700' },
  building: { border: 'border-l-indigo-400', bg: 'bg-indigo-400', badge: 'bg-indigo-100 text-indigo-700' },
  floor:    { border: 'border-l-teal-400',   bg: 'bg-teal-400',   badge: 'bg-teal-100 text-teal-700' },
  area:     { border: 'border-l-amber-400',  bg: 'bg-amber-400',  badge: 'bg-amber-100 text-amber-700' },
  wing:     { border: 'border-l-pink-400',   bg: 'bg-pink-400',   badge: 'bg-pink-100 text-pink-700' },
  section:  { border: 'border-l-cyan-400',   bg: 'bg-cyan-400',   badge: 'bg-cyan-100 text-cyan-700' },
};

export const PROJECT_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500' },
  { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-500' },
  { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500' },
  { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-500' },
  { bg: 'bg-cyan-50', border: 'border-cyan-200', icon: 'text-cyan-500' },
];

// Status "advancement" ordering — used to pick the worst (least-advanced)
// status when a task column aggregates several zone instances.
export const STATUS_ADVANCE: Record<string, number> = {
  not_started: 0, on_hold: 1, in_progress: 2, in_review: 3, completed: 4, cancelled: 5,
};
