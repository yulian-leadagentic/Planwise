import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';

import { AssignmentsService } from './assignments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';

@ApiTags('Assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an assignment' })
  create(@CurrentUser() user: any, @Body() dto: CreateAssignmentDto) {
    return this.assignmentsService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List assignments with filters' })
  @ApiQuery({ name: 'projectId', required: false, type: Number })
  @ApiQuery({ name: 'zoneId', required: false, type: Number })
  @ApiQuery({ name: 'deliverableId', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  findAll(
    @Query('projectId') projectId?: string,
    @Query('zoneId') zoneId?: string,
    @Query('deliverableId') deliverableId?: string,
    @Query('status') status?: string,
  ) {
    return this.assignmentsService.findAll({
      projectId: projectId ? parseInt(projectId, 10) : undefined,
      zoneId: zoneId ? parseInt(zoneId, 10) : undefined,
      deliverableId: deliverableId ? parseInt(deliverableId, 10) : undefined,
      status: status || undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get assignment with assignees and comments' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.assignmentsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an assignment' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssignmentDto,
  ) {
    return this.assignmentsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete an assignment' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.assignmentsService.remove(id);
  }

  @Post(':id/assignees')
  @ApiOperation({ summary: 'Add assignee to assignment' })
  addAssignee(
    @Param('id', ParseIntPipe) id: number,
    @Body('userId', ParseIntPipe) userId: number,
    @Body('role') role?: string,
  ) {
    return this.assignmentsService.addAssignee(id, userId, role);
  }

  @Delete(':id/assignees/:userId')
  @ApiOperation({ summary: 'Remove assignee from assignment' })
  removeAssignee(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.assignmentsService.removeAssignee(id, userId);
  }
}
