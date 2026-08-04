import { PageHeader } from '@/components/shared/page-header';
import { UserAvatar } from '@/components/shared/user-avatar';
import { useAuthStore } from '@/stores/auth.store';
import { useLogout } from '@/hooks/use-auth';

/**
 * Minimal profile page.
 *
 * The header user-menu and breadcrumbs already linked to /profile, but no
 * such route existed — so the router's catch-all silently bounced the click
 * to the dashboard. This is a lightweight read-only profile that makes the
 * link land somewhere real. Editing (name, password, avatar) can be layered
 * on later.
 */
export function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  if (!user) return null;

  // `email`/`userType` aren't in the narrow header usage but exist on the
  // User model; read defensively so this stays resilient to shape changes.
  const email = (user as any).email as string | undefined;
  const userType = (user as any).userType as string | undefined;

  return (
    <div className="space-y-6">
      <PageHeader title="Profile" description="Your account details" />

      <div className="max-w-lg rounded-[14px] border border-border bg-card p-6">
        <div className="flex items-center gap-4">
          <UserAvatar
            firstName={user.firstName}
            lastName={user.lastName}
            avatarUrl={user.avatarUrl}
            size="lg"
          />
          <div>
            <p className="text-base font-bold text-foreground">
              {user.firstName} {user.lastName}
            </p>
            {email && <p className="text-sm text-muted-foreground">{email}</p>}
            {userType && (
              <span className="mt-1 inline-block rounded-[5px] bg-muted px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {userType.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-4">
          <button
            onClick={() => logout.mutate()}
            className="rounded-lg border border-border px-3.5 py-2 text-[13px] font-semibold text-foreground hover:bg-accent"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
