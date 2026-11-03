/**
 * Shared constants for the Zone Templates feature and its sub-components.
 * Extracted verbatim from zone-templates-page.tsx.
 */

export const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
export const btnPrimary = 'flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
export const btnSecondary = 'rounded-md border border-border px-4 py-2 text-sm hover:bg-accent';

// ZT-5 · the hardcoded `ZONE_TYPES` list that used to live here was
// removed when all four remaining dropdowns switched to the catalog-
// driven `useZoneTypeOptions` hook. The admin-managed
// `/admin/config/zone-types` endpoint is now the single source of
// truth for which zone types are selectable in the UI.
//
// ZONE_DISPLAY is still used as a static color + label fallback for
// zone-type chips at render time; new catalog codes without a
// ZONE_DISPLAY entry fall back to the raw code with a neutral color.
export const ZONE_DISPLAY: Record<string, { color: string; label: string }> = {
  site: { color: '#6B7280', label: 'Site' },
  building: { color: '#3B82F6', label: 'Building' },
  level: { color: '#10B981', label: 'Level' },
  zone: { color: '#F59E0B', label: 'Zone' },
  area: { color: '#8B5CF6', label: 'Area' },
  section: { color: '#14B8A6', label: 'Section' },
  wing: { color: '#EC4899', label: 'Wing' },
  floor: { color: '#6B7280', label: 'Floor' },
};
