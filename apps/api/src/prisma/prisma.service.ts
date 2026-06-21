import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  applySoftDeleteMiddleware,
  applyQueryTimingMiddleware,
} from './prisma.middleware';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    // Timing middleware FIRST so the duration measured includes everything
    // downstream (soft-delete rewrite + actual SQL).
    applyQueryTimingMiddleware(this);
    applySoftDeleteMiddleware(this);
  }

  async onModuleInit() {
    await this.$connect();
  }
}
