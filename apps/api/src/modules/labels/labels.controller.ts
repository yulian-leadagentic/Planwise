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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { LabelsService } from './labels.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';

@ApiTags('Labels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('labels')
export class LabelsController {
  constructor(private readonly labelsService: LabelsService) {}

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a label' })
  create(@Body() dto: CreateLabelDto) {
    return this.labelsService.create(dto);
  }

  @Get('tree/:projectId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get label tree for a project' })
  getTree(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.labelsService.getTree(projectId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get a label by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.labelsService.findOne(id);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List labels by project' })
  findByProject(@Query('projectId', ParseIntPipe) projectId: number) {
    return this.labelsService.findByProject(projectId);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a label' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLabelDto) {
    return this.labelsService.update(id, dto);
  }

  @Patch(':id/reorder')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Reorder a label (move to new parent/position)' })
  reorder(
    @Param('id', ParseIntPipe) id: number,
    @Body('parentId') parentId: number | null,
    @Body('sortOrder') sortOrder: number,
  ) {
    return this.labelsService.reorder(id, parentId, sortOrder);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a label' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.labelsService.remove(id);
  }
}
