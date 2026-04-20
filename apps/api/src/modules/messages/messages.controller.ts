import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateMessageDto } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';

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
    return this.messagesService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List messages for an entity' })
  findAll(@Query() query: QueryMessagesDto) {
    return this.messagesService.findByEntity(query);
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
      user.id,
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
    return this.messagesService.search(query || '', user.id, {
      entityType,
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 20,
    });
  }

  @Get('analytics/overview')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get messaging analytics and KPIs' })
  analytics(@Query('projectId') projectId?: string) {
    return this.messagesService.getAnalytics(projectId ? Number(projectId) : undefined);
  }

  @Get('suggest-recipients/:entityType/:entityId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get suggested message recipients for an entity' })
  suggestRecipients(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
  ) {
    return this.messagesService.suggestRecipients(entityType as any, entityId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get message with thread' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.findOne(id);
  }

  @Get(':id/summarize')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get AI summary of a thread' })
  summarize(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.summarizeThread(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Edit message' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body('content') content: string,
  ) {
    return this.messagesService.update(id, user.id, content);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Delete message' })
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.messagesService.remove(id, user.id);
  }

  @Post(':id/resolve')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Mark thread as resolved' })
  resolve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.resolveThread(id, user.id);
  }

  @Post(':id/unresolve')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Mark thread as unresolved' })
  unresolve(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.unresolveThread(id);
  }
}
