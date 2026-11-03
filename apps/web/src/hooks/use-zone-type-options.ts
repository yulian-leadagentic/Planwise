/**
 * ZT-1 (QA4 · 2026-10-07) — shared hook for the "Default Zone Type"
 * dropdown. Replaces the previously-hardcoded `ZONE_TYPES` list in both
 * zone-template forms (`zone-templates-page.tsx` New-Template form and
 * `zone-templates/editor-view.tsx` Edit-Header form).
 *
 * Source of truth: `GET /admin/config/zone-types` → the editable
 * `zone_type_meta` catalog admins curate at `/admin/zone-types`. The
 * dropdown now reflects whatever rows that catalog currently exposes —
 * adding or removing a zone type in admin changes the dropdown with no
 * code change here.
 *
 * `value` on each `<option>` is the catalog's `code` column (lowercase
 * enum tag — e.g. `site`, `building`), which is exactly what
 * `Template.defaultZoneType` already stores. Options are sorted by the
 * catalog's `sortOrder` to match admin's ordering.
 *
 * Legacy guard — a template whose saved `defaultZoneType` is no longer
 * in the catalog (because admin deleted that meta row, or an older
 * code like `floor`/`zone`/`area`/`section` stuck around) still renders
 * as a selectable option, labelled with the prettified code so editing
 * the template doesn't silently drop the saved value. Pass the saved
 * value via `includeValue` to activate the guard.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import client from '@/api/client';

export type ZoneTypeOption = {
  code: string;
  label: string;
  isLegacy?: boolean;
};

type ZoneTypeMetaRow = {
  id: number;
  code: string;
  label: string;
  color: string;
  icon: string | null;
  sortOrder: number;
};

/** Turns a bare enum tag (`floor`) into a human label (`Floor`). */
export function prettifyZoneTypeCode(code: string): string {
  if (!code) return '';
  return code.charAt(0).toUpperCase() + code.slice(1);
}

export function useZoneTypeOptions(includeValue?: string | null): {
  options: ZoneTypeOption[];
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery<ZoneTypeMetaRow[]>({
    // Same key the admin page uses, so react-query dedupes requests
    // across the app and the dropdown reflects edits made in admin as
    // soon as that page invalidates the key.
    queryKey: ['admin', 'zone-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/config/zone-types').then((r) => r.data?.data ?? r.data),
  });

  const options = useMemo<ZoneTypeOption[]>(() => {
    const rows = Array.isArray(data) ? data : [];
    const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    const base: ZoneTypeOption[] = sorted.map((r) => ({ code: r.code, label: r.label }));

    // Legacy guard: if the saved value isn't in the catalog, append it
    // as a selectable option so the edit form doesn't blank out and
    // silently drop a saved selection on next save.
    const saved = (includeValue ?? '').trim();
    if (saved && !base.some((o) => o.code === saved)) {
      base.push({ code: saved, label: `${prettifyZoneTypeCode(saved)} (legacy)`, isLegacy: true });
    }
    return base;
  }, [data, includeValue]);

  return { options, isLoading };
}
