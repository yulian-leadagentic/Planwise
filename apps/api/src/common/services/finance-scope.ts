/**
 * Permissions round 4 (2026-11-23) — project scope of the money screens:
 * contracts, billings, expenses, milestones, cost reports, labor cost and
 * budget.
 *
 *   • `finance:read` → every project.
 *   • Anyone else → the route's own permission (checked by the guard) AND
 *     normal project access (ProjectAccessService).
 *
 * Money values stay stripped for callers without `finance:read` (round 2);
 * this file only decides WHICH projects' records are reachable.
 */
import { ProjectAccessService } from './project-access.service';
import { isAdminUser } from '../guards/roles.guard';
import { canSeeFinance } from '../finance/finance-access';
import { permissionDenied } from '../errors/permission-denied';

/**
 * Throws unless the caller may open a money record of `projectId`.
 * A record with no project is reachable only with `finance:read` (or as
 * Admin, who has every project): no project access can admit it.
 */
export async function assertFinanceProjectAccess(
  access: Pick<ProjectAccessService, 'assertProjectAccess'>,
  user: any,
  projectId: number | null | undefined,
): Promise<void> {
  if (canSeeFinance(user)) return;
  if (projectId == null) {
    if (isAdminUser(user)) return;
    throw permissionDenied('finance', 'read');
  }
  await access.assertProjectAccess(user.id, projectId, isAdminUser(user));
}

/**
 * Project ids a money list may show. `null` = no restriction
 * (`finance:read`, or Admin). An array limits the list to those
 * projects; records without a project are then left out.
 */
export async function financeProjectScope(
  access: Pick<ProjectAccessService, 'getAccessibleProjectIds'>,
  user: any,
): Promise<number[] | null> {
  if (canSeeFinance(user)) return null;
  const acc = await access.getAccessibleProjectIds(user.id, isAdminUser(user));
  return acc.all ? null : acc.projectIds;
}
