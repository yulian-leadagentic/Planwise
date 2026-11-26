import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';

/**
 * The Qualifications catalog (`professions` on the wire, QA4 split) and
 * the "hold any one" multi-select pill picker. Shared by Admin › Project
 * Role Types and Templates › Services (QA6 P4, PR-063 service gate).
 */

export interface Qualification {
  id: number;
  name: string;
  sortOrder: number;
}

export function useQualifications(enabled = true) {
  return useQuery<Qualification[]>({
    queryKey: ['professions'],
    staleTime: 10 * 60 * 1000,
    enabled,
    queryFn: () =>
      client.get('/admin/config/professions').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
}

/** Toggle `id` in a selection. */
export function toggleQualification(selected: number[], id: number): number[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

export function QualificationPicker({
  qualifications,
  value,
  onChange,
  emptyText = 'No qualifications defined yet.',
}: {
  qualifications: Qualification[];
  value: number[];
  onChange: (next: number[]) => void;
  emptyText?: string;
}) {
  if (qualifications.length === 0) {
    return <p className="text-[10px] italic text-slate-400 dark:text-slate-500">{emptyText}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Qualifications">
      {qualifications.map((p) => {
        const on = value.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggleQualification(value, p.id))}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] font-medium',
              on
                ? 'border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600',
            )}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
