import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { NotificationsService } from './notifications.service';
import { MessageAccessService } from '../messages/message-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

const DISCUSSION_ENTITIES = ['project', 'task', 'zone'];

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@OwnData()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly msgAccess: MessageAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List notifications for current user' })
  async findAll(
    @CurrentUser() user: any,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
  ) {
    const result = await this.notificationsService.findAll(user.id, {
      unreadOnly: unreadOnly === 'true',
      page: Number(page) || 1,
      perPage: Number(perPage) || 20,
    });
    // Round 4: whether the user has access to each row's entity, so the
    // bell opens a mention he can't otherwise reach in the discussion drawer.
    const canOpen = await this.msgAccess.entityOpener({ id: user.id, isAdmin: isAdminUser(user) }, result.data);
    return {
      ...result,
      data: result.data.map((n) => ({
        ...n,
        canOpenEntity:
          n.entityId != null && DISCUSSION_ENTITIES.includes(n.entityType ?? '')
            ? canOpen(n.entityType!, n.entityId)
            : null,
      })),
    };
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.notificationsService.markRead(id, user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: any) {
    return this.notificationsService.markAllRead(user.id);
  }
}
