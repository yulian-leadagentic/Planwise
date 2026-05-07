import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProjectPresence, type PresenceUser } from '@/hooks/use-presence';

/**
 * Small banner at the top of a project page showing other users who
 * are currently viewing the same project. Hidden when nobody else is
 * present so it doesn't add visual noise to a quiet page. Avatars are
 * stacked left-to-right with a "+N more" overflow when the list is long.
 */
export function PresenceIndicator({
  projectId,
  currentUserId,
}: {
  projectId: number;
  currentUserId?: number;
}) {
  const { others } = useProjectPresence(projectId, currentUserId);
  if (others.length === 0) return null;

  const visible = others.slice(0, 5);
  const overflow = others.length - visible.length;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-1.5 text-[12px]">
      <Users className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
      <span className="font-semibold text-emerald-700">
        {others.length === 1 ? '1 person is' : `${others.length} people are`} viewing this project right now
      </span>
      <div className="flex -space-x-1.5 ml-1">
        {visible.map((u) => (
          <PresenceAvatar key={u.id} user={u} />
        ))}
        {overflow > 0 && (
          <div className="h-6 w-6 rounded-full bg-slate-200 ring-2 ring-emerald-50 flex items-center justify-center text-[10px] font-bold text-slate-600">
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}

function PresenceAvatar({ user }: { user: PresenceUser }) {
  const initials = `${(user.firstName ?? '')[0] ?? ''}${(user.lastName ?? '')[0] ?? ''}`.toUpperCase() || '?';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Someone';
  return (
    <div
      title={fullName}
      className={cn(
        'h-6 w-6 rounded-full ring-2 ring-emerald-50 flex items-center justify-center text-[10px] font-bold',
        'bg-blue-600 text-white',
      )}
    >
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatarUrl} alt={fullName} className="h-full w-full rounded-full object-cover" />
      ) : (
        initials
      )}
    </div>
  );
}
