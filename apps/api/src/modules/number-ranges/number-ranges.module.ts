import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { NumberRangesController } from './number-ranges.controller';
import { NumberRangesService } from './number-ranges.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [NumberRangesController],
  providers: [NumberRangesService],
  exports: [NumberRangesService],
})
export class NumberRangesModule {}
