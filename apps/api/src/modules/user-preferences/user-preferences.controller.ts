import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserPreferencesService } from './user-preferences.service';

/**
 * `/users/me/preferences/:key` — per-user key/value preference store
 * (QA5 UI-13). Entirely user-scoped: the key is read + written against
 * `req.user.id`, so every endpoint carries the `@OwnData()` marker to
 * let the roles guard pass without a module permission check.
 *
 * Keys are opaque dotted strings owned by the feature that defined
 * them. Current registry (keep in sync when adding one):
 *   • `execution-board.column-order` — Execution Board deliverable
 *     column order from UI-13.
 */
@ApiTags('User Preferences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@OwnData()
@Controller('users/me/preferences')
export class UserPreferencesController {
  constructor(private readonly service: UserPreferencesService) {}

  @Get(':key')
  @ApiOperation({ summary: 'Get the current user\'s preference blob for one key (null when unset)' })
  async get(@CurrentUser() user: any, @Param('key') key: string) {
    assertKey(key);
    const value = await this.service.get(user.id, key);
    return { key, value };
  }

  @Put(':key')
  @ApiOperation({ summary: 'Upsert the current user\'s preference blob for one key' })
  async put(
    @CurrentUser() user: any,
    @Param('key') key: string,
    @Body() body: { value: Prisma.InputJsonValue },
  ) {
    assertKey(key);
    if (!body || !('value' in body)) {
      throw new BadRequestException(
        'Request body must include a `value` field (any JSON — object, array, string, number, boolean, or null).',
      );
    }
    await this.service.set(user.id, key, body.value);
    return { key, value: body.value };
  }
}

/**
 * Keys are feature-owned, dotted-lowercase, max 200 chars (matches the
 * VARCHAR). Rejecting path traversal / junk here keeps a malformed URL
 * from writing a row we'd then have to clean up by hand.
 */
function assertKey(key: string) {
  if (!key || key.length > 200) {
    throw new BadRequestException('preference key must be 1..200 characters.');
  }
  // Allow alnum, dot, dash, underscore. Enough for namespaced keys
  // like `execution-board.column-order`; forbids slashes and spaces so
  // paths and shell injection surfaces stay empty.
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new BadRequestException(
      'preference key may only contain letters, digits, `.`, `-`, and `_`.',
    );
  }
}
