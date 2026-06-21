import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';

/**
 * Slow-query timing middleware.
 *
 * $use wraps the entire await of the query — that includes pool wait time
 * AND actual SQL execution. If the connection pool is exhausted, queries
 * stack up here and the duration includes the wait. So a slow log here
 * surfaces BOTH a slow SQL query and pool starvation, which is what we
 * want — both lead to wedges.
 *
 * Threshold is 500ms. Tune if it gets noisy; the goal is to catch slow
 * endpoints that precede a wedge, not to log every legitimate big query.
 */
const SLOW_QUERY_MS = 500;
const queryLogger = new Logger('SlowQuery');

export function applyQueryTimingMiddleware(prisma: PrismaClient) {
  prisma.$use(async (params, next) => {
    const start = Date.now();
    try {
      return await next(params);
    } finally {
      const ms = Date.now() - start;
      if (ms > SLOW_QUERY_MS) {
        queryLogger.warn(
          `${params.model ?? '?'}.${params.action} durationMs=${ms}`,
        );
      }
    }
  });
}

const SOFT_DELETE_MODELS: Prisma.ModelName[] = [
  'User',
  'Project',
  'Label',
  'Task',
  'TaskAssignee',
  'TaskComment',
  'TimeEntry',
  'Contract',
  'ContractItem',
  'LabelMilestone',
  'Contact',
  'Expense',
  'Term',
];

export function applySoftDeleteMiddleware(prisma: PrismaClient) {
  prisma.$use(async (params, next) => {
    if (!params.model || !SOFT_DELETE_MODELS.includes(params.model as Prisma.ModelName)) {
      return next(params);
    }

    // Intercept delete -> soft delete
    if (params.action === 'delete') {
      params.action = 'update';
      params.args['data'] = { deletedAt: new Date() };
    }

    if (params.action === 'deleteMany') {
      params.action = 'updateMany';
      if (params.args.data) {
        params.args.data['deletedAt'] = new Date();
      } else {
        params.args['data'] = { deletedAt: new Date() };
      }
    }

    // Filter out soft-deleted records on reads
    if (params.action === 'findFirst' || params.action === 'findMany') {
      if (!params.args) {
        params.args = {};
      }
      if (params.args.where) {
        if (params.args.where.deletedAt === undefined) {
          params.args.where.deletedAt = null;
        }
      } else {
        params.args.where = { deletedAt: null };
      }
    }

    if (params.action === 'findUnique' || params.action === 'findUniqueOrThrow') {
      // findUnique doesn't allow non-unique fields in where, so change to findFirst
      params.action = 'findFirst';
      if (!params.args) {
        params.args = {};
      }
      if (params.args.where) {
        if (params.args.where.deletedAt === undefined) {
          params.args.where.deletedAt = null;
        }
      } else {
        params.args.where = { deletedAt: null };
      }
    }

    return next(params);
  });
}
