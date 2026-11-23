import { NoAccess } from '@/components/shared/no-access';
import { isPermissionDenied } from '@/lib/notify';

/** Owner-approved wording (permissions round 4, 2026-11-23). */
export const PROJECT_NO_ACCESS_MESSAGE = 'אין לך גישה לפרויקט הזה, בקש ממנהל הפרויקט להוסיף אותך';

/**
 * What the project page shows when the project didn't load: the
 * No-access card for a 403, "Project not found" for anything else (404).
 */
export function ProjectUnavailable({ error }: { error: unknown }) {
  if (isPermissionDenied(error)) {
    return <NoAccess variant="page" what="this project" message={PROJECT_NO_ACCESS_MESSAGE} />;
  }
  return <p className="py-8 text-center text-slate-400 dark:text-slate-500">Project not found</p>;
}
