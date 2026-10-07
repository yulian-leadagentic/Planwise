import { Module } from '@nestjs/common';

import { UserPreferencesController } from './user-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';

/**
 * Per-user key/value preference store. See
 * `./user-preferences.controller.ts` and `docs/bm2/qa5-ui-fixes-batch.md`
 * (UI-13) for the key registry and request shape.
 */
@Module({
  controllers: [UserPreferencesController],
  providers: [UserPreferencesService],
  exports: [UserPreferencesService],
})
export class UserPreferencesModule {}
