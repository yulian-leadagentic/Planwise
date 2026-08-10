import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DriveAdminController } from './drive-admin.controller';
import { DriveAdminService } from './drive-admin.service';

/**
 * DriveAdminModule — CRUD + test surface for OrgDriveConfig.
 * Depends on SecretCryptoModule (global) for encrypt/decrypt of the
 * service-account JSON key, and ActivityLogModule (global) for audit rows.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DriveAdminController],
  providers: [DriveAdminService],
  exports: [DriveAdminService],
})
export class DriveAdminModule {}
