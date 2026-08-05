import { Users } from 'lucide-react';

export function OrgRow({ displayName, email, phone, bpId, onOpenProfile }: {
  displayName: string; email: string | null; phone: string | null; bpId: number;
  onOpenProfile?: (bpId: number) => void;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-white dark:bg-slate-900 p-3 flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
        <Users className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => onOpenProfile?.(bpId)}
          className="text-sm font-semibold text-slate-900 dark:text-slate-100 hover:underline truncate text-left w-full"
          title="Open partner profile"
        >
          {displayName}
        </button>
        {(email || phone) && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{email}{email && phone ? ' · ' : ''}{phone}</p>
        )}
      </div>
    </div>
  );
}
