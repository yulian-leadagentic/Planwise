import { Navigate, useParams } from 'react-router-dom';

/**
 * Legacy /tasks/:id entry point.
 *
 * The canonical task surface is now the TaskDrawer opened via
 * ?task=N on the tasks list (see tasks-page.tsx + useDrawerRoute).
 * Every UI caller was migrated in ux/task-surface; this route is kept
 * ALIVE only so bookmarks / external links / notification emails that
 * still reference /tasks/:id keep resolving — they land on the tasks
 * page with the drawer already open.
 *
 * `useNavigate + useEffect` gave a brief blank flash on first paint,
 * so we render <Navigate replace> directly instead. `replace` means
 * the pathname doesn't sit in the history stack — hitting Back from
 * the drawer takes the user to wherever they came from, not to this
 * intermediate URL.
 */
export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const parsed = id ? Number(id) : NaN;
  // If the id is bogus (non-numeric / <=0), send them to the tasks
  // list without opening a drawer instead of a broken ?task=NaN URL.
  const target = Number.isFinite(parsed) && parsed > 0
    ? `/tasks?task=${parsed}`
    : '/tasks';
  return <Navigate to={target} replace />;
}
