import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  NumberRangesService,
  UpsertNumberRangeDto,
} from './number-ranges.service';

@ApiTags('Admin - Number Ranges')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/number-ranges')
export class NumberRangesController {
  constructor(private readonly service: NumberRangesService) {}

  @Get()
  @RequirePermissions({ module: 'admin/number-ranges', action: 'read' })
  @ApiOperation({ summary: 'List all number ranges' })
  findAll() {
    return this.service.findAll();
  }

  @Get('peek')
  @RequirePermissions({ module: 'admin/number-ranges', action: 'read' })
  @ApiOperation({ summary: 'Preview next code for a range (auto mode only)' })
  peek(@Query('code') code: string) {
    return this.service.peek(code).then((preview) => ({ preview }));
  }

  @Get(':id')
  @RequirePermissions({ module: 'admin/number-ranges', action: 'read' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions({ module: 'admin/number-ranges', action: 'write' })
  @ApiOperation({ summary: 'Create a number range' })
  create(@Body() dto: UpsertNumberRangeDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'admin/number-ranges', action: 'write' })
  @ApiOperation({ summary: 'Update a number range (currentNumber can only move forward; code is immutable)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<UpsertNumberRangeDto>,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'admin/number-ranges', action: 'delete' })
  @ApiOperation({ summary: 'Delete a number range (entity-kind references become null)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
