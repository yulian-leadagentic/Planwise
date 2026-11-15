/**
 * §12 (2026-11-14) · `zoneType` validation on POST /zones and
 * PATCH /zones/:id.
 *
 * An unknown `zoneType` used to pass the DTO (`@IsString`), reach
 * Prisma, fail its enum check and surface as a 500. These specs run the
 * two DTOs through a ValidationPipe configured exactly like the global
 * one in `main.ts`, i.e. the layer that now answers 400.
 */
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateZoneDto, LEGACY_ZONE_TYPE_MAP, ZONE_TYPE_VALUES, normalizeZoneType } from './create-zone.dto';
import { UpdateZoneDto } from './update-zone.dto';

// Mirror of `app.useGlobalPipes(new ValidationPipe({...}))` in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const asCreate: ArgumentMetadata = { type: 'body', metatype: CreateZoneDto };
const asUpdate: ArgumentMetadata = { type: 'body', metatype: UpdateZoneDto };

async function rejection(body: unknown, meta: ArgumentMetadata): Promise<BadRequestException> {
  try {
    await pipe.transform(body, meta);
  } catch (err) {
    return err as BadRequestException;
  }
  throw new Error('expected the ValidationPipe to reject the body');
}
const messages = (err: BadRequestException): string[] => (err.getResponse() as { message: string[] }).message;

describe('zoneType allowed set', () => {
  it('is exactly the Prisma ZoneType enum — the only values the column can store', () => {
    expect([...ZONE_TYPE_VALUES].sort()).toEqual(['building', 'level', 'site', 'wing']);
  });

  it('every legacy code maps onto a member of that set (ZT-3 mapping)', () => {
    expect(LEGACY_ZONE_TYPE_MAP).toEqual({ floor: 'level', area: 'site', zone: 'building', section: 'wing' });
    for (const mapped of Object.values(LEGACY_ZONE_TYPE_MAP)) expect(ZONE_TYPE_VALUES).toContain(mapped);
  });
});

describe('CreateZoneDto — zoneType', () => {
  const base = { projectId: 59, name: 'Tower A' };

  it('rejects an unknown zoneType with a 400 that names the allowed values', async () => {
    const err = await rejection({ ...base, zoneType: 'banana' }, asCreate);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(messages(err)).toEqual(['zoneType must be one of: site, building, level, wing']);
  });

  it.each([[42], [true], [['building']], [{ code: 'building' }]])(
    'rejects a non-string / non-enum zoneType (%j) with a 400',
    async (zoneType) => {
      const err = await rejection({ ...base, zoneType }, asCreate);
      expect(err.getStatus()).toBe(400);
      expect(messages(err).join(' ')).toContain('zoneType must be one of');
    },
  );

  it.each(ZONE_TYPE_VALUES)('accepts the enum value "%s" unchanged', async (zoneType) => {
    const dto: CreateZoneDto = await pipe.transform({ ...base, zoneType }, asCreate);
    expect(dto).toBeInstanceOf(CreateZoneDto);
    expect(dto.zoneType).toBe(zoneType);
  });

  it.each([
    ['zone', 'building'], // what both Add-Zone forms in the planning modal post by default
    ['floor', 'level'],
    ['area', 'site'],
    ['section', 'wing'],
  ])('accepts the legacy code "%s" and normalises it to "%s"', async (legacy, expected) => {
    const dto: CreateZoneDto = await pipe.transform({ ...base, zoneType: legacy }, asCreate);
    expect(dto.zoneType).toBe(expected);
  });

  it('is case- and whitespace-insensitive, like the legacy backfill was', async () => {
    const dto: CreateZoneDto = await pipe.transform({ ...base, zoneType: '  Level ' }, asCreate);
    expect(dto.zoneType).toBe('level');
  });

  it.each([[undefined], [null], ['']])(
    'treats a missing / null / empty zoneType (%j) as "not provided"',
    async (zoneType) => {
      const dto: CreateZoneDto = await pipe.transform({ ...base, zoneType }, asCreate);
      expect(dto.zoneType).toBeUndefined();
    },
  );
});

describe('UpdateZoneDto — zoneType (inherits the rule through PartialType)', () => {
  it('rejects an unknown zoneType with the same 400', async () => {
    const err = await rejection({ zoneType: 'penthouse' }, asUpdate);

    expect(err.getStatus()).toBe(400);
    expect(messages(err)).toEqual(['zoneType must be one of: site, building, level, wing']);
  });

  it('accepts enum values, normalises legacy codes, and leaves an update without zoneType alone', async () => {
    const wing: UpdateZoneDto = await pipe.transform({ zoneType: 'wing' }, asUpdate);
    expect(wing.zoneType).toBe('wing');

    const legacy: UpdateZoneDto = await pipe.transform({ zoneType: 'floor' }, asUpdate);
    expect(legacy.zoneType).toBe('level');

    const rename: UpdateZoneDto = await pipe.transform({ name: 'Tower B' }, asUpdate);
    expect(rename.zoneType).toBeUndefined();
    expect(rename.name).toBe('Tower B');
  });
});

describe('normalizeZoneType', () => {
  it('passes values it cannot interpret through, for @IsIn to reject', () => {
    expect(normalizeZoneType('banana')).toBe('banana');
    expect(normalizeZoneType(42)).toBe(42);
  });
});
