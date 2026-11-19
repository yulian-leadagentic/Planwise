/**
 * POST /zones/apply-task-template — access routing + context hand-off.
 *
 * The planning-modal "From Template" pickers call this for both a zone
 * target and the project root. Same guard shape as the other zone /
 * project endpoints: `projects:write` + zone access (zone target) or
 * project access (root target).
 */
import { ForbiddenException } from '@nestjs/common';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { ZonesController } from './zones.controller';

function makeController() {
  const access: any = {
    assertZoneAccess: jest.fn(async () => 59),
    assertProjectAccess: jest.fn(async () => undefined),
  };
  const zonesService: any = {
    applyTaskTemplateToTarget: jest.fn(async () => ({ tasks: [], dependenciesCreated: 0 })),
  };
  const controller = new ZonesController(zonesService, access);
  return { controller, access, zonesService };
}

const user = { id: 42, roleId: 3 };

describe('ZonesController.applyTaskTemplateToTarget', () => {
  it('requires projects:write', () => {
    const perms = Reflect.getMetadata(ROLES_KEY, ZonesController.prototype.applyTaskTemplateToTarget);
    expect(perms).toEqual([{ module: 'projects', action: 'write' }]);
  });

  it('zone target — asserts zone access and passes the zone + group context through', async () => {
    const { controller, access, zonesService } = makeController();

    await controller.applyTaskTemplateToTarget(user, {
      projectId: 59,
      templateId: 41,
      zoneId: 12,
      phaseId: 9,
    });

    expect(access.assertZoneAccess).toHaveBeenCalledWith(42, 12, 3);
    expect(access.assertProjectAccess).not.toHaveBeenCalled();
    expect(zonesService.applyTaskTemplateToTarget).toHaveBeenCalledWith(
      { projectId: 59, zoneId: 12 },
      41,
      42,
      { projectDeliverableId: null, deliverableTemplateId: null, phaseId: 9, serviceTypeId: null },
    );
  });

  it('project-root target — asserts project access and passes zoneId null', async () => {
    const { controller, access, zonesService } = makeController();

    await controller.applyTaskTemplateToTarget(user, {
      projectId: 59,
      templateId: 41,
      zoneId: null,
      deliverableTemplateId: 41,
    });

    expect(access.assertProjectAccess).toHaveBeenCalledWith(42, 59, 3);
    expect(access.assertZoneAccess).not.toHaveBeenCalled();
    expect(zonesService.applyTaskTemplateToTarget).toHaveBeenCalledWith(
      { projectId: 59, zoneId: null },
      41,
      42,
      { projectDeliverableId: null, deliverableTemplateId: 41, phaseId: null, serviceTypeId: null },
    );
  });

  it('an access refusal stops the apply', async () => {
    const { controller, access, zonesService } = makeController();
    access.assertProjectAccess.mockRejectedValueOnce(new ForbiddenException());

    await expect(
      controller.applyTaskTemplateToTarget(user, { projectId: 59, templateId: 41 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(zonesService.applyTaskTemplateToTarget).not.toHaveBeenCalled();
  });
});
