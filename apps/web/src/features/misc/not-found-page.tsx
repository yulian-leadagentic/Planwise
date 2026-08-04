import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

/**
 * 404 page. Rendered for any unmatched route INSIDE the app shell, so the
 * user keeps their navigation and can recover — instead of the previous
 * behaviour where the router silently redirected every unknown URL to "/"
 * (which hid deleted-entity / mistyped-link errors).
 */
export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Compass className="h-7 w-7 text-muted-foreground" />
      </div>
      <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground">Page not found</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        The page you're looking for doesn't exist or may have been moved.
      </p>
      <Link
        to="/"
        className="mt-5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
