import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { BillingsController } from './billings.controller';
import { BillingsService } from './billings.service';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  // Round 4 — ProjectAccessService for the per-project money scope.
  imports: [AuthorizationModule],
  controllers: [ContractsController, BillingsController],
  providers: [ContractsService, BillingsService],
  exports: [ContractsService],
})
export class ContractsModule {}
