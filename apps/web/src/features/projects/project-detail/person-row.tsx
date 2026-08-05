import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ACCENTS } from './constants';
import { getInitials } from './utils';
import type { ProjectTeamPerson } from './types';

export function PersonRow({ row, onRemove, accent, compact = false, onOpenProfile, heldRoles }: {
  row: ProjectTeamPerson;
  onRemove: () => void;
  accent: keyof typeof ACCENTS;
  compact?: boolean;
  onOpenProfile?: (bpId: number) => void;
  /** ProjectRoleType names this person holds on the project (Architect,
   *  Engineer, etc.). Rendered as small chips next to the name so users
   *  see at a glance what role each team member plays. Optional —
   *  Customer Contacts and other non-team rows don't pass this. */
  heldRoles?: string[];
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border bg-white dark:bg-slate-900',
      ACCENTS[accent].border,
      compact ? 'p-2' : 'p-3',
    )}>
      <div className={cn(
        'flex items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
        ACCENTS[accent].badge,
        compact ? 'h-7 w-7' : 'h-8 w-8',
      )}>
        {getInitials(row.firstName ?? '', row.lastName ?? '') || row.displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => onOpenProfile?.(row.businessPartnerId)}
            className={cn('font-medium text-slate-900 dark:text-slate-100 hover:underline truncate text-left', compact ? 'text-[13px]' : 'text-sm')}
            title="Open partner profile"
          >
            {row.displayName}
          </button>
          {heldRoles && heldRoles.length > 0 && (
            <div className="flex flex-wrap gap-1 shrink-0">
              {heldRoles.map((r) => (
                <span
                  key={r}
                  className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700"
                  title={`Project role: ${r}`}
                >
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {[row.roleInContext, row.email].filter(Boolean).join(' · ') || row.position || '—'}
        </p>
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50"
        title="End relationship"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
