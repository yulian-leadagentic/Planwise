/**
 * CreateOrganizationModal — thin compatibility wrapper around the
 * canonical CreatePartnerModal. Consolidated in ux/partner-contact.
 *
 * Locks the partner type to `organization` so an Organization-shaped
 * entry point (e.g. the Partners page "Add Organization" button, or
 * the /contacts "New → New Organization" split menu) can't be flipped
 * to Person mid-flow.
 */
import { CreatePartnerModal } from './create-partner-modal';

export function CreateOrganizationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  return (
    <CreatePartnerModal
      onClose={onClose}
      onCreated={onCreated}
      defaultPartnerType="organization"
      lockPartnerType
    />
  );
}
