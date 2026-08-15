import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { BusinessPartnersController } from './business-partners.controller';
import { BusinessPartnersService } from './business-partners.service';
// BM2 Phase E — Excel BP + Contacts import wizard support.
import { BpImportService } from './bp-import.service';
import { ExcelParserService } from '../data-import/excel-parser.service';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

@Module({
  imports: [
    MulterModule.register({
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  ],
  controllers: [BusinessPartnersController],
  // AuditInterceptor is provided at the module level so @UseInterceptors
  // can resolve it via DI on the controller.
  // ExcelParserService is a stateless helper; providing a fresh instance
  // here (also provided in DataImportModule) is fine — they don't share state.
  providers: [BusinessPartnersService, BpImportService, ExcelParserService, AuditInterceptor],
  exports: [BusinessPartnersService],
})
export class BusinessPartnersModule {}
