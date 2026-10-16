import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TimeEntriesService } from './time-entries.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';

/**
 * HR §9.1 (2026-10-16) — bucket-gate enforcement on TimeEntry writes.
 *
 * The picker (`GET /hr/me/pickable-buckets`) is UX only. These tests
 * lock in the real server-side gate: the `assertUsableBucket` path on
 * `create()` must reject inactive buckets, B·AUTO buckets, and
 * B·REPORTED buckets without an eligibility window — and allow
 * B·REPORTED when the caller has an active eligibility covering the
 * entry's date, as well as A/C buckets, and no-bucket entries.
 *
 * Prisma is fully mocked. The create() path depends on the task
 * lookup (projectId derivation), overlap scan, bucket validation,
 * timeEntry.create, and the completion-sync aggregate — the harness
 * wires minimal stubs for each.
 */
describe('TimeEntriesService.create — bucket gate (HR §9.1)', () => {
  let service: TimeEntriesService;
  let prisma: {
    specialHourBucket: { findUnique: jest.Mock };
    employeeBucketEligibility: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    timeEntry: {
      findMany: jest.Mock;
      create: jest.Mock;
      aggregate: jest.Mock;
      update: jest.Mock;
    };
  };

  const USER_ID = 42;
  // DTO date is 'YYYY-MM-DD'; the service parses it to local midnight.
  // The eligibility window below is built the same way so the inclusive
  // comparison still matches regardless of the test host's timezone.
  const ENTRY_DATE_STR = '2026-10-20';

  const baseDto = {
    date: ENTRY_DATE_STR,
    taskId: 100,
    projectId: 200,
    minutes: 60,
    note: null,
  };

  beforeEach(async () => {
    prisma = {
      specialHourBucket: { findUnique: jest.fn() },
      employeeBucketEligibility: { findFirst: jest.fn() },
      task: {
        findUnique: jest.fn().mockResolvedValue({
          projectId: 200,
          budgetHours: null,
          status: 'in_progress',
        }),
      },
      timeEntry: {
        // No existing same-day entries → no overlap conflict.
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 1,
          minutes: 60,
          projectId: 200,
          taskId: 100,
          task: { name: 't' },
        }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { minutes: 0 } }),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TimeEntriesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ActivityLogService,
          useValue: { write: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = moduleRef.get(TimeEntriesService);
  });

  // ─── Rejection paths ────────────────────────────────────────────────

  it('rejects inactive bucket with TIME_ENTRY_BUCKET_INACTIVE', async () => {
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 5,
      code: 'A-RETIRED',
      active: false,
      behavior: 'A',
      defaultCreditMode: 'REPORTED',
    });

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 5 }),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ENTRY_BUCKET_INACTIVE' },
    });
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('rejects unknown bucket id with TIME_ENTRY_BUCKET_INACTIVE', async () => {
    // Unknown + inactive share the same client-facing code: pick another
    // bucket. The error message distinguishes for the ops log.
    prisma.specialHourBucket.findUnique.mockResolvedValue(null);

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 999 }),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ENTRY_BUCKET_INACTIVE' },
    });
  });

  it('rejects B bucket with no eligibility (TIME_ENTRY_BUCKET_B_NO_ELIGIBILITY)', async () => {
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 7,
      code: 'B-RESERVE',
      active: true,
      behavior: 'B',
      defaultCreditMode: 'REPORTED',
    });
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue(null);

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 7 }),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ENTRY_BUCKET_B_NO_ELIGIBILITY' },
    });
  });

  it('rejects B·AUTO bucket even with eligibility (TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE)', async () => {
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 8,
      code: 'B-AUTO',
      active: true,
      behavior: 'B',
      defaultCreditMode: 'AUTO',
    });
    // Eligibility exists and inherits bucket default (AUTO) → still
    // rejected because the HR monthly engine credits automatically.
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue({
      id: 11,
      creditMode: null,
    });

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 8 }),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE' },
    });
  });

  it('rejects B bucket when eligibility override resolves to AUTO', async () => {
    // Bucket default is REPORTED but the row's override flips to AUTO.
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 9,
      code: 'B-OVERRIDE',
      active: true,
      behavior: 'B',
      defaultCreditMode: 'REPORTED',
    });
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue({
      id: 12,
      creditMode: 'AUTO',
    });

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 9 }),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE' },
    });
  });

  // ─── Allow paths ────────────────────────────────────────────────────

  it('accepts B·REPORTED bucket when eligibility covers the date', async () => {
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 10,
      code: 'B-PARENTAL',
      active: true,
      behavior: 'B',
      defaultCreditMode: 'REPORTED',
    });
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue({
      id: 13,
      creditMode: null, // inherit REPORTED
    });

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 10 }),
    ).resolves.toBeTruthy();

    // The eligibility query must key off the authenticated userId and
    // the entry's date — not any userId from the DTO (there is none)
    // and not "today".
    const whereArg = prisma.employeeBucketEligibility.findFirst.mock.calls[0][0].where;
    expect(whereArg.userId).toBe(USER_ID);
    expect(whereArg.bucketId).toBe(10);
    expect(whereArg.active).toBe(true);
    expect(whereArg.startDate).toHaveProperty('lte');
    expect(whereArg.endDate).toHaveProperty('gte');

    expect(prisma.timeEntry.create).toHaveBeenCalled();
  });

  it('accepts active A bucket without any eligibility lookup', async () => {
    prisma.specialHourBucket.findUnique.mockResolvedValue({
      id: 1,
      code: 'A-MEETING',
      active: true,
      behavior: 'A',
      defaultCreditMode: 'REPORTED',
    });

    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: 1 }),
    ).resolves.toBeTruthy();

    // A + C short-circuit — no eligibility hit.
    expect(prisma.employeeBucketEligibility.findFirst).not.toHaveBeenCalled();
    expect(prisma.timeEntry.create).toHaveBeenCalled();
  });

  it('accepts an entry with no bucket (null-path)', async () => {
    await expect(
      service.create(USER_ID, { ...baseDto, specialHourBucketId: null }),
    ).resolves.toBeTruthy();

    expect(prisma.specialHourBucket.findUnique).not.toHaveBeenCalled();
    expect(prisma.employeeBucketEligibility.findFirst).not.toHaveBeenCalled();
  });
});
