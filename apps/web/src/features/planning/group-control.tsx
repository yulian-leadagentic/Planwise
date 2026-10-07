/**
 * Shared Group + Sub-group selector.
 *
 * UI-14 (QA5 Wave 2) — extracted from the Planning tab's inline control
 * (planning-modal.tsx ~L6284) so the Deliverable Planning tab can mount
 * the same look-and-feel without duplicating the two-select cluster.
 * The Planning tab itself still ships its own 3-level variant (zone /
 * deliverable / service / tertiary); this shared one is a 2-level cut
 * sized for Deliverable Planning but structured so Planning can migrate
 * to it in a follow-up without a rewrite.
 *
 * Dimensions here use SEMANTIC names (zone/deliverable/service) rather
 * than the Planning tab's internal shorthand (zone/service/phase) so
 * reading code outside planning-modal doesn't require decoding the
 * historical naming. Mapping, for future reference:
 *   Planning tab 'service'  =  our 'deliverable'
 *   Planning tab 'phase'    =  our 'service'
 */
import type { ReactNode } from 'react';

export type DPGroupDim = 'zone' | 'deliverable' | 'service';

const DIM_LABEL: Record<DPGroupDim, string> = {
  zone: 'Zone',
  deliverable: 'Deliverable',
  service: 'Service',
};

export function dpGroupDimLabel(dim: DPGroupDim): string {
  return DIM_LABEL[dim];
}

export function GroupControl({
  primary,
  secondary,
  onChangePrimary,
  onChangeSecondary,
  label = 'Group',
  dimensions = ['zone', 'deliverable', 'service'],
}: {
  /** Primary group dimension. Changing it trims the secondary when it
   *  would collide (same guard the Planning tab's control applies).
   *  `null` here means "No grouping" — the secondary select is hidden. */
  primary: DPGroupDim | null;
  /** Optional secondary group inside each primary bucket. `null` =
   *  no sub-group. */
  secondary: DPGroupDim | null;
  onChangePrimary: (next: DPGroupDim | null) => void;
  onChangeSecondary: (next: DPGroupDim | null) => void;
  /** Short lead-in label — "Group" by default; callers can override. */
  label?: ReactNode;
  /** Dimensions to offer. Default = all three. The order controls the
   *  <option> ordering. */
  dimensions?: DPGroupDim[];
}) {
  // When the primary changes to a dim that was the secondary, drop the
  // secondary (same guard the Planning tab's inline control applies).
  const handlePrimary = (raw: string) => {
    if (raw === '') {
      onChangePrimary(null);
      onChangeSecondary(null);
      return;
    }
    const next = raw as DPGroupDim;
    if (secondary === next) onChangeSecondary(null);
    onChangePrimary(next);
  };

  const handleSecondary = (raw: string) => {
    if (raw === '') { onChangeSecondary(null); return; }
    onChangeSecondary(raw as DPGroupDim);
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500">{label}</span>
      <select
        value={primary ?? ''}
        onChange={(e) => handlePrimary(e.target.value)}
        className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
      >
        {dimensions.map((d) => (
          <option key={d} value={d}>{DIM_LABEL[d]}</option>
        ))}
        <option value="">No Grouping</option>
      </select>
      {primary && (
        <>
          <span className="text-slate-300 dark:text-slate-600 text-[11px]">/</span>
          <select
            value={secondary ?? ''}
            onChange={(e) => handleSecondary(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            title="Optional sub-group inside each primary group"
          >
            <option value="">No sub-group</option>
            {dimensions
              .filter((d) => d !== primary)
              .map((d) => (
                <option key={d} value={d}>{DIM_LABEL[d]}</option>
              ))}
          </select>
        </>
      )}
    </div>
  );
}
