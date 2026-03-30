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

import { ServicesService } from './services.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@ApiTags('Services')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Post('/projects/:projectId/services')
  @ApiOperation({ summary: 'Create a service for a project' })
  create(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CreateServiceDto,
  ) {
    return this.servicesService.create(projectId, dto);
  }

  @Get('/projects/:projectId/services')
  @ApiOperation({ summary: 'List services for a project (with deliverables)' })
  findAll(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.servicesService.findAll(projectId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a service' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.servicesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a service' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servicesService.remove(id);
  }
}
