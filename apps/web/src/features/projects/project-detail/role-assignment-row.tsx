import { X, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getInitials } from './utils';
import type { ProjectRoleAssignment } from './types';

export function RoleAssignmentRow({
  assignment,
  onRemove,
  onOpenProfile,
}: {
  assignment: ProjectRoleAssignment;
  onRemove: () => void;
  onOpenProfile?: (bpId: number) => void;
}) {
  const p = assignment.party;
  const initials = getInitials(p.firstName ?? '', p.lastName ?? '') || p.displayName.slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-white dark:bg-slate-900 p-3">
      <div className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
        p.partnerType === 'organization' ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700',
      )}>
        {p.partnerType === 'organization' ? <Users className="h-4 w-4" /> : initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onOpenProfile?.(p.id)}
            className="text-sm font-semibold text-slate-900 dark:text-slate-100 hover:underline truncate text-left"
            title="Open partner profile"
          >
            {p.displayName}
          </button>
          <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">({p.partnerType})</span>
          {assignment.isPrimary && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">PRIMARY</span>
          )}
        </div>
        {assignment.titleInProject && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{assignment.titleInProject}</p>}
        {(p.email || p.phone) && (
          <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{p.email}{p.email && p.phone ? ' · ' : ''}{p.phone}</p>
        )}
      </div>
      <button
        onClick={onRemove}
        className="rounded p-1.5 text-slate-400 dark:text-slate-500 hover:text-red-600 hover:bg-red-50"
        title="End assignment"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
