import { Module } from '@nestjs/common';
import { NumberRangesModule } from '../number-ranges/number-ranges.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserSenioritiesService } from './user-seniorities.service';

@Module({
  imports: [NumberRangesModule],
  controllers: [UsersController],
  providers: [UsersService, UserSenioritiesService],
  // UserSenioritiesService is exported so cost-calculation services
  // (projects.service, reports.service, planning.service) can resolve
  // a user's date-effective seniority for each TimeEntry.
  exports: [UsersService, UserSenioritiesService],
})
export class UsersModule {}
