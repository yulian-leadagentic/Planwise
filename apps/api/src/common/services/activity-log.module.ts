/**
 * Global module that exports ActivityLogService so every domain
 * service can inject it without each module having to declare it
 * in its own providers list. Marked @Global so the import in
 * AppModule is enough.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ActivityLogService } from './activity-log.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [ActivityLogService],
  exports: [ActivityLogService],
})
export class ActivityLogModule {}
