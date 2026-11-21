/**
 * Create-task modal · server-side missing fields (2026-11-21).
 *
 * The API's core-task guard answers a 400 MISSING_REQUIRED_FIELDS with
 * the empty fields in `error.details.missing` (today 'zoneId' or
 * 'serviceTypeId'). This turns that into the modal's `fieldErrors` keys
 * so the same red-field highlighting as the local check lights up.
 */
import { apiMissingFields } from '@/lib/notify';

/** Server field name → the modal's fieldErrors key, where they differ. */
const FIELD_KEY: Record<string, string> = {
  // One Deliverable dropdown covers both kinds; it is keyed projectDeliverableId.
  deliverableTemplateId: 'projectDeliverableId',
};

/** The modal's field keys to mark red, or null when the error is not a missing-fields 400. */
export function createTaskFieldErrors(error: unknown): Set<string> | null {
  const missing = apiMissingFields(error);
  return missing ? new Set(missing.map((k) => FIELD_KEY[k] ?? k)) : null;
}
