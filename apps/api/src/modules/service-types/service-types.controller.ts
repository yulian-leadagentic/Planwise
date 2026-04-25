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

import { ServiceTypesService } from './service-types.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CreateServiceTypeDto } from './dto/create-service-type.dto';
import { UpdateServiceTypeDto } from './dto/update-service-type.dto';

@ApiTags('ServiceTypes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('service-types')
export class ServiceTypesController {
  constructor(private readonly serviceTypesService: ServiceTypesService) {}

  @Get()
  @RequirePermissions({ module: 'templates/types', action: 'read' })
  @ApiOperation({ summary: 'List all service types' })
  findAll() {
    return this.serviceTypesService.findAll();
  }

  @Post()
  @RequirePermissions({ module: 'templates/types', action: 'write' })
  @ApiOperation({ summary: 'Create a service type' })
  create(@Body() dto: CreateServiceTypeDto) {
    return this.serviceTypesService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'templates/types', action: 'write' })
  @ApiOperation({ summary: 'Update a service type' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateServiceTypeDto,
  ) {
    return this.serviceTypesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'templates/types', action: 'delete' })
  @ApiOperation({ summary: 'Delete a service type' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.serviceTypesService.remove(id);
  }
}
