export type TabKey = 'time' | 'details' | 'files' | 'discussion';
export const VALID_TABS: TabKey[] = ['time', 'details', 'files', 'discussion'];
export function parseTab(raw: string | null, hideTimeTab: boolean): TabKey | null {
  if (!raw || !VALID_TABS.includes(raw as TabKey)) return null;
  // 'time' isn't valid when the Time tab is hidden.
  if (raw === 'time' && hideTimeTab) return null;
  return raw as TabKey;
}
