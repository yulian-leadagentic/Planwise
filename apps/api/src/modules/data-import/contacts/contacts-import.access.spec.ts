/**
 * Permissions round 4 (review fix) — the contacts import can attach every
 * imported person to a project (`attachToProjectId`), which changes that
 * project's team. Like the Team tab, that is leader-or-Admin only
 * (`assertProjectManage`), checked before anything is written.
 */
import { NotFoundException } from '@nestjs/common';

import { ContactsImportController } from './contacts-import.controller';
import { PermissionDeniedException } from '../../../common/errors/permission-denied';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const IMPORTER = { id: 4, isAdmin: false, roleModules: [perm('/data-import/contacts', { canRead: true, canWrite: true })] };
const LEADER = { ...IMPORTER, id: 7 };
const ADMIN = { ...IMPORTER, id: 1, isAdmin: true };

/** Project 59 is led by user 7; project 404 does not exist. */
function fakeAccess() {
  return {
    assertProjectManage: jest.fn(async (user: any, projectId: number) => {
      if (projectId === 404) throw new NotFoundException('Project not found');
      if (user.isAdmin || (projectId === 59 && user.id === 7)) return;
      throw new PermissionDeniedException(
        "Only the project leader or an administrator can change this project's team or settings.",
        { module: 'projects', reason: 'NOT_PROJECT_LEADER' },
      );
    }),
  };
}

function makeController() {
  const commitService: any = { commit: jest.fn(async () => ({ created: 1 })) };
  const access = fakeAccess();
  const ctrl = new ContactsImportController(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    commitService,
    access as any,
  );
  return { ctrl, commitService, access };
}

const body = (extra: Record<string, unknown> = {}): any => ({
  sheet: { name: 'Sheet1', rows: [] },
  mapping: {},
  ...extra,
});

describe('POST /data-import/contacts/commit — attach to a project', () => {
  it('an importer who is not the project leader cannot attach the people to the project; nothing is written', async () => {
    const { ctrl, commitService, access } = makeController();
    const err = await ctrl.commit(IMPORTER, body({ attachToProjectId: 59, projectRoleId: 3 })).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.details.reason).toBe('NOT_PROJECT_LEADER');
    expect(access.assertProjectManage).toHaveBeenCalledWith(IMPORTER, 59);
    expect(commitService.commit).not.toHaveBeenCalled();
  });

  it('the project leader and an Admin may attach', async () => {
    const { ctrl, commitService } = makeController();
    await ctrl.commit(LEADER, body({ attachToProjectId: 59 }));
    await ctrl.commit(ADMIN, body({ attachToProjectId: 59 }));
    expect(commitService.commit).toHaveBeenCalledTimes(2);
    expect(commitService.commit.mock.calls[0][0]).toMatchObject({ attachToProjectId: 59 });
  });

  it('a project that does not exist → 404 before any write', async () => {
    const { ctrl, commitService } = makeController();
    await expect(ctrl.commit(ADMIN, body({ attachToProjectId: 404 }))).rejects.toBeInstanceOf(NotFoundException);
    expect(commitService.commit).not.toHaveBeenCalled();
  });

  it('an import without a project needs no project check', async () => {
    const { ctrl, commitService, access } = makeController();
    await ctrl.commit(IMPORTER, body({ attachToProjectId: null }));
    await ctrl.commit(IMPORTER, body());
    expect(access.assertProjectManage).not.toHaveBeenCalled();
    expect(commitService.commit).toHaveBeenCalledTimes(2);
  });

  it('the import permission is still checked first', async () => {
    const { ctrl, commitService, access } = makeController();
    const noImport = { id: 7, isAdmin: false, roleModules: [] };
    await expect(ctrl.commit(noImport, body({ attachToProjectId: 59 }))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    expect(access.assertProjectManage).not.toHaveBeenCalled();
    expect(commitService.commit).not.toHaveBeenCalled();
  });
});
