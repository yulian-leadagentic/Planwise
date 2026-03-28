import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { applySoftDeleteMiddleware } from './prisma.middleware';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    applySoftDeleteMiddleware(this);
  }

  async onModuleInit() {
    await this.$connect();
  }
}
