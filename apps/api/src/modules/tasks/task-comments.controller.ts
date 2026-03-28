import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { TaskCommentsService } from './task-comments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateCommentDto } from './dto/create-comment.dto';

@ApiTags('Task Comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tasks/:taskId/comments')
export class TaskCommentsController {
  constructor(private readonly commentsService: TaskCommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Add comment to task' })
  create(
    @Param('taskId', ParseIntPipe) taskId: number,
    @CurrentUser() user: any,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentsService.create(taskId, user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List task comments' })
  findAll(@Param('taskId', ParseIntPipe) taskId: number) {
    return this.commentsService.findAll(taskId);
  }

  @Patch(':commentId')
  @ApiOperation({ summary: 'Update a comment' })
  update(
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: any,
    @Body('content') content: string,
  ) {
    return this.commentsService.update(commentId, user.id, content);
  }

  @Delete(':commentId')
  @ApiOperation({ summary: 'Delete a comment' })
  remove(
    @Param('commentId', ParseIntPipe) commentId: number,
    @CurrentUser() user: any,
  ) {
    return this.commentsService.remove(commentId, user.id);
  }
}
