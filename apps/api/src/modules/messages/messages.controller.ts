import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
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
  @ApiOperation({ summary: 'Create a message' })
  create(@CurrentUser() user: any, @Body() dto: CreateMessageDto) {
    return this.messagesService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List messages for an entity' })
  findAll(@Query() query: QueryMessagesDto) {
    return this.messagesService.findByEntity(query);
  }

  @Get('inbox')
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

  @Get(':id')
  @ApiOperation({ summary: 'Get message with thread' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit message' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body('content') content: string,
  ) {
    return this.messagesService.update(id, user.id, content);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete message' })
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.messagesService.remove(id, user.id);
  }

  // ─── Resolved/Unresolved ─────────────────────────────────────────────────

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Mark thread as resolved' })
  resolve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.messagesService.resolveThread(id, user.id);
  }

  @Post(':id/unresolve')
  @ApiOperation({ summary: 'Mark thread as unresolved' })
  unresolve(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.unresolveThread(id);
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  @Get('search/query')
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

  // ─── Analytics ───────────────────────────────────────────────────────────

  @Get('analytics/overview')
  @ApiOperation({ summary: 'Get messaging analytics and KPIs' })
  analytics(@Query('projectId') projectId?: string) {
    return this.messagesService.getAnalytics(projectId ? Number(projectId) : undefined);
  }

  // ─── AI Features ─────────────────────────────────────────────────────────

  @Get('suggest-recipients/:entityType/:entityId')
  @ApiOperation({ summary: 'Get suggested message recipients for an entity' })
  suggestRecipients(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
  ) {
    return this.messagesService.suggestRecipients(entityType as any, entityId);
  }

  @Get(':id/summarize')
  @ApiOperation({ summary: 'Get AI summary of a thread' })
  summarize(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.summarizeThread(id);
  }
}
