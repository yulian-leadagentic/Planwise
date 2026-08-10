import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SsoAdminController } from './sso-admin.controller';
import { SsoAdminService } from './sso-admin.service';

/**
 * SsoAdminModule — CRUD + test surface for OrgAuthConfig.
 * Depends on SecretCryptoModule (global) for encrypt/decrypt of the
 * OIDC client_secret, and ActivityLogModule (global) for audit rows.
 */
@Module({
  imports: [PrismaModule],
  controllers: [SsoAdminController],
  providers: [SsoAdminService],
  exports: [SsoAdminService],
})
export class SsoAdminModule {}
