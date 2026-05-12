import { Module } from '@nestjs/common';
import { NumberRangesModule } from '../number-ranges/number-ranges.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [NumberRangesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
