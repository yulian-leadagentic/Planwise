/**
 * "Attach Google Drive file" — Modal that takes a Drive URL and
 * attaches the file to a task OR deliverable. Uses the shared
 * Modal (with useFocusTrap) so escape / backdrop / dirty-check
 * behavior matches every other dialog in the app.
 *
 * The backend does the fileId parsing, permission check (SA must be
 * able to reach the file), and metadata fetch. The UI just POSTs the
 * URL and reacts to the response.
 *
 * Not-configured handling: DriveNotConfigured (503) is caught and
 * surfaced as a toast. The permission-model note is repeated inside
 * the modal so users don't paste a link and then wonder why colleagues
 * can't see it.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Info, HardDrive } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import client from '@/api/client';
import { notify } from '@/lib/notify';

type Target = { kind: 'task'; taskId: number } | { kind: 'deliverable'; deliverableId: number };

interface Props {
  open: boolean;
  onClose: () => void;
  target: Target;
  /** Invalidated on success so the file list refreshes. */
  invalidateKeys?: readonly (readonly (string | number)[])[];
}

export function AttachDriveFileModal({ open, onClose, target, invalidateKeys }: Props) {
  const qc = useQueryClient();
  const [driveUrl, setDriveUrl] = useState('');

  const endpoint =
    target.kind === 'task'
      ? `/tasks/${target.taskId}/drive/attach`
      : `/deliverables/${target.deliverableId}/drive/attach`;

  const attach = useMutation({
    mutationFn: () =>
      client.post(endpoint, { driveUrl: driveUrl.trim() }).then((r) => r.data?.data ?? r.data),
    onSuccess: () => {
      notify.success('Drive file attached', { code: 'DRIVE-ATTACH-200' });
      (invalidateKeys ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k as any }));
      setDriveUrl('');
      onClose();
    },
    onError: (err: any) => {
      const status = err?.response?.status;
      if (status === 503) {
        notify.info(
          'Google Drive is not configured. Ask your admin to set it up in Admin → Google Drive.',
          { code: 'DRIVE-NOT-CONFIGURED' },
        );
        return;
      }
      if (status === 403) {
        notify.error(
          err?.response?.data?.message ??
            "The service account can't access this file. Make sure it's inside your Shared Drive.",
          { code: 'DRIVE-ATTACH-403' },
        );
        return;
      }
      notify.apiError(err, 'Failed to attach Drive file');
    },
  });

  const canSubmit = driveUrl.trim().length > 0 && !attach.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          Attach Google Drive file
        </span>
      }
      description="Paste a share link from Google Drive. The file must live inside your organization's Shared Drive."
      widthClass="w-[520px] max-w-[92vw]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => attach.mutate()}
            disabled={!canSubmit}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {attach.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Attach
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Google Drive share link<span className="text-red-500 dark:text-red-400 ml-0.5">*</span>
          </span>
          <textarea
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none resize-y min-h-[80px]"
            placeholder="https://drive.google.com/file/d/1abcXYZ.../view"
            value={driveUrl}
            onChange={(e) => setDriveUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="rounded-lg border border-blue-100 dark:border-blue-900/60 bg-blue-50/70 dark:bg-blue-950/30 p-3 text-[12px] text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Access is granted by Google based on Shared Drive membership. Colleagues who can't already see the file in Drive won't see it here either.
          </span>
        </div>
      </div>
    </Modal>
  );
}
