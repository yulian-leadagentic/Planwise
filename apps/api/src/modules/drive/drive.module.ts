import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { DriveService } from './drive.service';
import { DriveController } from './drive.controller';

/**
 * DriveModule — service + controller for Google-Drive folder ensure
 * and attach-by-URL. Uses:
 *   - SecretCryptoModule (global) to decrypt the stored SA JSON key
 *   - AuthorizationModule for ProjectAccessService
 *   - ActivityLogModule (global) is available if needed downstream
 *
 * NEVER call permissions.* on any Drive resource. See drive.service.ts
 * for the full invariant.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [DriveController],
  providers: [DriveService],
  exports: [DriveService],
})
export class DriveModule {}
