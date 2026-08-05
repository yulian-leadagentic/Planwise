/**
 * CreateContactModal — thin compatibility wrapper around the canonical
 * CreatePartnerModal. Consolidated in ux/partner-contact so there's
 * ONE creation form to maintain.
 *
 * External callers (project-detail-page.tsx's "add customer contact"
 * flow) keep working unchanged: the `preselectEmployerOrgId` and
 * `lockEmployer` props are forwarded verbatim. The wrapper hard-locks
 * the type to `person` so users don't accidentally flip to Organization
 * mid-flow from a Contact-shaped entry point.
 *
 * All fields + validation + the partial-failure warnings pattern
 * (professions / worker_of) live inside CreatePartnerModal now.
 */
import { CreatePartnerModal } from './create-partner-modal';

export function CreateContactModal({
  onClose,
  onCreated,
  preselectEmployerOrgId,
  lockEmployer,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  preselectEmployerOrgId?: number;
  lockEmployer?: boolean;
}) {
  return (
    <CreatePartnerModal
      onClose={onClose}
      onCreated={onCreated}
      defaultPartnerType="person"
      lockPartnerType
      preselectEmployerOrgId={preselectEmployerOrgId}
      lockEmployer={lockEmployer}
    />
  );
}
