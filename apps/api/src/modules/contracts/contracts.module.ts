import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { BillingsController } from './billings.controller';
import { BillingsService } from './billings.service';

@Module({
  controllers: [ContractsController, BillingsController],
  providers: [ContractsService, BillingsService],
  exports: [ContractsService],
})
export class ContractsModule {}
