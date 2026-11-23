import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { BusinessPartnersController } from './business-partners.controller';
import { BusinessPartnersService } from './business-partners.service';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [
    MulterModule.register({
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
    // ProjectAccessService — a partner's project rows are cut to the
    // caller's projects (permissions round 4).
    AuthorizationModule,
  ],
  controllers: [BusinessPartnersController],
  // AuditInterceptor is provided at the module level so @UseInterceptors
  // can resolve it via DI on the controller.
  providers: [BusinessPartnersService, AuditInterceptor],
  exports: [BusinessPartnersService],
})
export class BusinessPartnersModule {}
