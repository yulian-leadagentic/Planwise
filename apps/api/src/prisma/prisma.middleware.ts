import { PrismaClient, Prisma } from '@prisma/client';

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
