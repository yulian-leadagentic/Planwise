import { Module } from '@nestjs/common';

import { HrController } from './hr.controller';
import { HrService } from './hr.service';

/**
 * HR Phase A3 (2026-10-15) — mounts the `/hr/*` controller + service.
 * Only PrismaModule is needed as a dependency (via the global provider
 * registered in AppModule); the module exposes no provider of its own
 * so there's nothing to export.
 */
@Module({
  controllers: [HrController],
  providers: [HrService],
})
export class HrModule {}
