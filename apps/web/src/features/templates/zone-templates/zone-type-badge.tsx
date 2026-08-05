import { ZONE_DISPLAY } from './constants';

// ---------------------------------------------------------------------------
// Zone Type Badge
// ---------------------------------------------------------------------------

export function ZoneTypeBadge({ zoneType }: { zoneType: string }) {
  const display = ZONE_DISPLAY[zoneType] ?? { color: '#6B7280', label: zoneType };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white"
      style={{ backgroundColor: display.color }}
    >
      {display.label}
    </span>
  );
}
