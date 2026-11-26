/**
 * QA6 PR-063 — the Service ↔ Qualification link: PATCH /phases/:id takes
 * `requiredProfessionIds` (number[] | null, checked against the
 * professions table) and GET /phases returns it.
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MemoryDb, memoryPrisma } from '../../testing/memory-prisma';
import { PhasesController } from './phases.controller';
import { PhasesService } from './phases.service';
import { UpdatePhaseDto } from './dto/update-phase.dto';

function world() {
  const db = new MemoryDb({}, {
    phase: [
      { id: 7, name: 'BIM Coordination', code: 'BIM', kind: 'service', isActive: true, sortOrder: 1, requiredProfessionIds: null },
      { id: 8, name: 'Design', code: null, kind: 'phase', isActive: true, sortOrder: 2, requiredProfessionIds: null },
    ],
    profession: [{ id: 3, name: 'BIM Coordinator' }, { id: 4, name: 'Modeler' }],
  });
  const prisma = memoryPrisma(db);
  const ctrl = new PhasesController(new PhasesService(prisma));
  const row = () => db.table('phase').find((p) => p.id === 7)!;
  return { db, ctrl, row };
}

describe('PATCH /phases/:id — requiredProfessionIds', () => {
  it('stores distinct, sorted ids; GET /phases returns them', async () => {
    const w = world();
    await w.ctrl.update(7, { requiredProfessionIds: [4, 3, 3] } as any);
    expect(w.row().requiredProfessionIds).toEqual([3, 4]);
    const all: any[] = await w.ctrl.findAll();
    expect(all.find((p) => p.id === 7).requiredProfessionIds).toEqual([3, 4]);
    const services: any[] = await w.ctrl.findAll('services');
    expect(services.find((p) => p.id === 7).requiredProfessionIds).toEqual([3, 4]);
  });

  it('null or [] clears the requirement; omitted leaves it as is', async () => {
    const w = world();
    await w.ctrl.update(7, { requiredProfessionIds: [3] } as any);
    await w.ctrl.update(7, { name: 'BIM Coordination' } as any);
    expect(w.row().requiredProfessionIds).toEqual([3]);
    await w.ctrl.update(7, { requiredProfessionIds: [] } as any);
    expect(w.row().requiredProfessionIds).toBe(Prisma.DbNull);
    await w.ctrl.update(7, { requiredProfessionIds: [3] } as any);
    await w.ctrl.update(7, { requiredProfessionIds: null } as any);
    expect(w.row().requiredProfessionIds).toBe(Prisma.DbNull);
  });

  it('an unknown qualification id is a 400 PROFESSION_NOT_FOUND and nothing is written', async () => {
    const w = world();
    const err = await w.ctrl.update(7, { requiredProfessionIds: [3, 99] } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'PROFESSION_NOT_FOUND', message: 'Unknown qualification id(s): 99.' });
    expect(w.row().requiredProfessionIds).toBeNull();
  });

  it('the DTO accepts number[] or null and refuses anything else', async () => {
    const check = async (body: any) => (await validate(plainToInstance(UpdatePhaseDto, body))).length;
    expect(await check({ requiredProfessionIds: [3, 4] })).toBe(0);
    expect(await check({ requiredProfessionIds: null })).toBe(0);
    expect(await check({})).toBe(0);
    expect(await check({ requiredProfessionIds: ['a'] })).toBeGreaterThan(0);
    expect(await check({ requiredProfessionIds: [0] })).toBeGreaterThan(0);
    expect(await check({ requiredProfessionIds: 3 })).toBeGreaterThan(0);
  });
});
