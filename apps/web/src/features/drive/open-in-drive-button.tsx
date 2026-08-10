/**
 * "Open in Drive" — button that (a) ensures the Drive folder for a
 * project / zone / deliverable exists, (b) opens its webViewLink in
 * a new tab.
 *
 * Design: the button is small (icon + label) so it fits inline on
 * headers and table rows. Uses `FolderOpen` from lucide for
 * recognisability without dragging in a full Drive logo.
 *
 * Fallback: if the API returns webViewLink=null (which can happen
 * for freshly-created folders in some Shared-Drive setups), build
 * the deterministic URL from the folderId.
 *
 * Not-configured handling: the DriveNotConfigured error (503) is
 * caught and surfaced as a toast — the user shouldn't see a red
 * error page for an admin-only setup gap.
 */

import { useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

type Entity = 'project' | 'zone' | 'deliverable';

interface Props {
  entity: Entity;
  id: number;
  /** "sm" for row buttons, "md" for page headers. */
  size?: 'sm' | 'md';
  /** Extra classes on the button element. */
  className?: string;
  /** Optional label — defaults to "Open in Drive". */
  label?: string;
}

const ENDPOINT: Record<Entity, (id: number) => string> = {
  project: (id) => `/projects/${id}/drive/folder`,
  zone: (id) => `/zones/${id}/drive/folder`,
  deliverable: (id) => `/deliverables/${id}/drive/folder`,
};

export function OpenInDriveButton({ entity, id, size = 'sm', className, label }: Props) {
  const [pending, setPending] = useState(false);

  const ensureAndOpen = useMutation({
    mutationFn: () =>
      client.post(ENDPOINT[entity](id)).then((r) => r.data?.data ?? r.data),
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: (data: { folderId: string; webViewLink: string | null }) => {
      // Fall back to the deterministic Drive URL if webViewLink is
      // missing — Google occasionally omits it on newly-created
      // folders inside Shared Drives.
      const url =
        data.webViewLink ??
        (data.folderId ? `https://drive.google.com/drive/folders/${data.folderId}` : null);
      if (!url) {
        notify.error('Drive folder response missing a URL', { code: 'DRIVE-OPEN-NOURL' });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onError: (err: any) => {
      // 503 = DriveNotConfigured — surface a friendly note; the
      // user can't fix this, but they should know to ask their admin.
      const status = err?.response?.status;
      if (status === 503) {
        notify.info(
          'Google Drive is not configured. Ask your admin to set it up in Admin → Google Drive.',
          { code: 'DRIVE-NOT-CONFIGURED' },
        );
        return;
      }
      notify.apiError(err, 'Failed to open in Drive');
    },
  });

  const sizeCls =
    size === 'md'
      ? 'text-[13px] font-semibold px-3.5 py-2'
      : 'text-[12px] font-semibold px-2.5 py-1.5';

  return (
    <button
      type="button"
      onClick={() => ensureAndOpen.mutate()}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 disabled:opacity-50',
        sizeCls,
        className,
      )}
      title="Open the Google Drive folder for this in a new tab"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <FolderOpen className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
      )}
      {label ?? 'Open in Drive'}
    </button>
  );
}
