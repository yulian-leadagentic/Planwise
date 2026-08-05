/**
 * Shared constants for project-detail-page sub-components. Extracted
 * verbatim from project-detail-page.tsx.
 */

export const ACCENTS = {
  indigo:  { border: 'border-indigo-200',  badge: 'bg-indigo-100 text-indigo-700' },
  blue:    { border: 'border-blue-200',    badge: 'bg-blue-100 text-blue-700' },
  violet:  { border: 'border-violet-200',  badge: 'bg-violet-100 text-violet-700' },
  emerald: { border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700' },
} as const;

// Shared input class used by the M4a pickers.
export const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';
