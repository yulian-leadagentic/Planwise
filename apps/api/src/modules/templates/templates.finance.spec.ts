/**
 * Permissions round 2 (2026-11-20) — B-16: the template price list
 * (`defaultBudgetAmount` on template tasks / zone tasks) is set or
 * changed only with finance:write; an unchanged echo passes. Reads are
 * covered by the global finance interceptor.
 */
import { ForbiddenException } from '@nestjs/common';

import { TemplatesController } from './templates.controller';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const EDITOR = { id: 4, isAdmin: false, roleModules: [perm('/templates', { canRead: true, canWrite: true })] };
const FINANCE_EDITOR = {
  id: 5,
  isAdmin: false,
  roleModules: [perm('/templates', { canRead: true, canWrite: true }), perm('/finance', { canRead: true, canWrite: true })],
};

function make() {
  const templatesService: any = {
    findOne: jest.fn(async () => ({ id: 41, type: 'task_list' })),
    create: jest.fn(async () => ({ id: 41 })),
    addTask: jest.fn(async () => ({ id: 1 })),
    updateTask: jest.fn(async () => ({ id: 1 })),
    addZoneTask: jest.fn(async () => ({ id: 2 })),
    getTaskMoneySnapshot: jest.fn(async () => ({ defaultBudgetAmount: '1500.00' })),
  };
  return { ctrl: new TemplatesController(templatesService), templatesService };
}

describe('template price list writes (B-16)', () => {
  it('PATCH /templates/tasks/:id — a changed price needs finance:write; an echo passes', async () => {
    const { ctrl, templatesService } = make();
    await expect(ctrl.updateTask(EDITOR, 1, { defaultBudgetAmount: 2000 })).rejects.toThrow(
      /You can't change price-list amounts — that needs permission to change financial data/,
    );
    expect(templatesService.updateTask).not.toHaveBeenCalled();
    await ctrl.updateTask(EDITOR, 1, { name: 'Renamed', defaultBudgetAmount: 1500 });
    await ctrl.updateTask(FINANCE_EDITOR, 1, { defaultBudgetAmount: 2000 });
    expect(templatesService.updateTask).toHaveBeenCalledTimes(2);
  });

  it('new template tasks / zone tasks / inline tasks with a price need finance:write', async () => {
    const { ctrl, templatesService } = make();
    await expect(ctrl.addTask(EDITOR, 41, { name: 'T', defaultBudgetAmount: 10 })).rejects.toThrow(ForbiddenException);
    await expect(ctrl.addZoneTask(EDITOR, 3, { name: 'T', defaultBudgetAmount: 10 })).rejects.toThrow(ForbiddenException);
    await expect(
      ctrl.create(EDITOR, { name: 'Tpl', type: 'task_list', tasks: [{ name: 'a' }, { name: 'b', defaultBudgetAmount: 5 }] }),
    ).rejects.toThrow(ForbiddenException);
    expect(templatesService.addTask).not.toHaveBeenCalled();
    expect(templatesService.addZoneTask).not.toHaveBeenCalled();
    expect(templatesService.create).not.toHaveBeenCalled();

    await ctrl.addTask(EDITOR, 41, { name: 'T', defaultBudgetHours: 8 });
    await ctrl.addZoneTask(EDITOR, 3, { name: 'T', defaultBudgetAmount: null });
    await ctrl.create(EDITOR, { name: 'Tpl', type: 'task_list', tasks: [{ name: 'a' }] });
    expect(templatesService.addTask).toHaveBeenCalled();
    expect(templatesService.addZoneTask).toHaveBeenCalled();
    expect(templatesService.create).toHaveBeenCalled();
  });
});
