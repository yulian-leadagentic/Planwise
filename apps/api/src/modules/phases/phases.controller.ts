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

import { PhasesService } from './phases.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CreatePhaseDto } from './dto/create-phase.dto';
import { UpdatePhaseDto } from './dto/update-phase.dto';

@ApiTags('Phases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('phases')
export class PhasesController {
  constructor(private readonly phasesService: PhasesService) {}

  @Get()
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'List all phases' })
  findAll() {
    return this.phasesService.findAll();
  }

  @Post()
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Create a phase' })
  create(@Body() dto: CreatePhaseDto) {
    return this.phasesService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Update a phase' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePhaseDto,
  ) {
    return this.phasesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'templates', action: 'delete' })
  @ApiOperation({ summary: 'Delete a phase' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.phasesService.remove(id);
  }
}
