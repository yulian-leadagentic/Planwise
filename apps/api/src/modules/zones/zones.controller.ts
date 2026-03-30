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

import { ZonesService } from './zones.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@ApiTags('Zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('zones')
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new zone' })
  create(@Body() dto: CreateZoneDto) {
    return this.zonesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List zones for a project (flat list)' })
  findAll(@Query('projectId', ParseIntPipe) projectId: number) {
    return this.zonesService.findAll(projectId);
  }

  @Get('tree/:projectId')
  @ApiOperation({ summary: 'Get zone tree for a project (nested)' })
  findTree(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.zonesService.findTree(projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single zone' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.zonesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a zone' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.zonesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a zone' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.zonesService.remove(id);
  }

  @Post(':id/copy-structure')
  @ApiOperation({ summary: 'Copy zone structure to a new parent' })
  copyStructure(
    @Param('id', ParseIntPipe) id: number,
    @Body('newParentId', ParseIntPipe) newParentId: number,
  ) {
    return this.zonesService.copyStructure(id, newParentId);
  }

  @Post(':id/explode-typical')
  @ApiOperation({ summary: 'Explode typical zone into individual zones' })
  explodeTypical(@Param('id', ParseIntPipe) id: number) {
    return this.zonesService.explodeTypical(id);
  }
}
