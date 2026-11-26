import { useRef } from 'react';
import { UserPlus } from 'lucide-react';
import { Modal } from '@/components/shared/modal';
import { TEAM_CONFIRM_APPROVAL_NOTE, teamConfirmWords, type TeamConfirmText } from '../workload-drop-guards';

/**
 * QA6 round 3 (26.11) · guard 4: a drop that would add someone to a
 * project Team (he is not on it, and the caller is the leader or an
 * Admin) asks first. On staging an Admin's mistaken drop silently added
 * a real employee to the Team.
 *
 * Built on the shared Modal shell (the design system's modal: overlay,
 * rounded-2xl panel, header / body / footer, focus trap, Escape and
 * backdrop close = Cancel). Focus starts on Cancel: a keyboard drag drops
 * with Space, and a second Space must not add the person.
 */
export function WorkloadTeamConfirm({
  request,
  onCancel,
  onConfirm,
}: {
  /** null = closed. */
  request: TeamConfirmText | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!request) return null;
  const w = teamConfirmWords(request);
  return (
    <Modal
      open
      onClose={onCancel}
      title="Add to the project team?"
      description={
        <span data-testid="workload-team-confirm-text">
          <bdi>{w.lead}</bdi> is not on the team of <bdi>{w.project}</bdi>. Add <bdi>{w.person}</bdi> to the project team as a participant and assign{' '}
          <bdi className={request.task.code?.trim() ? 'font-mono text-xs font-medium' : undefined}>{w.task}</bdi> on {request.day}?
        </span>
      }
      initialFocusRef={cancelRef}
      bodyClassName={request.needsApproval ? 'px-5 py-4' : 'hidden'}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 transition-all duration-150"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 transition-all duration-150"
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Add and assign
          </button>
        </>
      }
    >
      {request.needsApproval ? <p className="text-[13px] text-slate-600 dark:text-slate-300">{TEAM_CONFIRM_APPROVAL_NOTE}</p> : null}
    </Modal>
  );
}
