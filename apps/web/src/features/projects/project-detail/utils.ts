/**
 * Small formatters used by project-detail-page and its sub-components.
 * Extracted verbatim from project-detail-page.tsx.
 */

export function getInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
}

export function formatShortDate(dateStr: string | null) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function formatBudget(amount: number) {
  return new Intl.NumberFormat('he-IL', {
    style: 'decimal',
    maximumFractionDigits: 0,
  }).format(amount);
}
