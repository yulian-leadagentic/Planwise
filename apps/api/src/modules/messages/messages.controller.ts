import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { MessagesService } from './messages.service';
import { MessageViewer } from './message-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateMessageDto } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';

/** Round 4: the caller as the thread-visibility checks need him. */
function viewerOf(user: any): MessageViewer {
  return { id: user.id, isAdmin: isAdminUser(user) };
}

@ApiTags('Messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Create a message' })
  create(@CurrentUser() user: any, @Body() dto: CreateMessageDto) {
    return this.messagesService.create(viewerOf(user), dto);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List messages for an entity' })
  findAll(@CurrentUser() user: any, @Query() query: QueryMessagesDto) {
    return this.messagesService.findByEntity(query, viewerOf(user));
  }

  /**
   * Batch message-counts endpoint. Returns a map of entityId → count
   * for the given entityIds — used by the planning grid's TaskDiscussion
   * buttons so we don't fire one request per task row (the N+1 that
   * caused the slow-page report). Caller passes
   *   GET /messages/counts?entityType=task&entityIds=1,2,3
   * and gets `{ "1": 2, "2": 0, "3": 5 }` back.
   */
  @Get('counts')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Batch message counts for many entityIds' })
  counts(
    @CurrentUser() user: any,
    @Query('entityType') entityType: string,
    @Query('entityIds') entityIds: string,
  ) {
    const ids = (entityIds ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    return this.messagesService.countByEntities(viewerOf(user), entityType, ids);
  }

  @Get('inbox')
  @OwnData()
  @ApiOperation({ summary: 'Personal inbox' })
  inbox(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.messagesService.getInbox(
      viewerOf(user),
      page ? Number(page) : 1,
      perPage ? Number(perPage) : 20,
    );
  }

  @Get('search/query')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Search across all discussions' })
  search(
    @CurrentUser() user: any,
    @Query('q') query: string,
    @Query('entityType') entityType?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.messagesService.search(query || '', viewerOf(user), {
      entityType,
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 20,
    });
  }

  @Get('analytics/overview')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get messaging analytics and KPIs' })
  analytics(@CurrentUser() user: any, @Query('projectId') projectId?: string) {
    return this.messagesService.getAnalytics(viewerOf(user), projectId ? Number(projectId) : undefined);
  }

  @Get('suggest-recipients/:entityType/:entityId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get suggested message recipients for an entity' })
  suggestRecipients(
    @CurrentUser() user: any,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
  ) {
    return this.messagesService.suggestRecipients(viewerOf(user), entityType, entityId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get message with thread' })
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.findOne(id, viewerOf(user));
  }

  @Get(':id/summarize')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get AI summary of a thread' })
  summarize(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.summarizeThread(id, viewerOf(user));
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Edit message' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body('content') content: string,
  ) {
    return this.messagesService.update(id, viewerOf(user), content);
  }

  // Round 4: same grant as posting; the service allows only the author,
  // the project leader or an Admin.
  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Delete message' })
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.messagesService.remove(id, viewerOf(user));
  }

  @Post(':id/resolve')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Mark thread as resolved' })
  resolve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.resolveThread(id, viewerOf(user));
  }

  @Post(':id/unresolve')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Mark thread as unresolved' })
  unresolve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.unresolveThread(id, viewerOf(user));
  }
}
