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

import { DeliverablesService } from './deliverables.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateDeliverableDto } from './dto/create-deliverable.dto';
import { UpdateDeliverableDto } from './dto/update-deliverable.dto';
import { LinkZonesDto } from './dto/link-zones.dto';

@ApiTags('Deliverables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('deliverables')
export class DeliverablesController {
  constructor(private readonly deliverablesService: DeliverablesService) {}

  @Post('/services/:serviceId/deliverables')
  @ApiOperation({ summary: 'Create a deliverable for a service' })
  create(
    @Param('serviceId', ParseIntPipe) serviceId: number,
    @Body() dto: CreateDeliverableDto,
  ) {
    return this.deliverablesService.create(serviceId, dto);
  }

  @Get('/services/:serviceId/deliverables')
  @ApiOperation({ summary: 'List deliverables for a service' })
  findAll(@Param('serviceId', ParseIntPipe) serviceId: number) {
    return this.deliverablesService.findAll(serviceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a deliverable' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeliverableDto,
  ) {
    return this.deliverablesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a deliverable' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.deliverablesService.remove(id);
  }

  @Post(':id/link-zones')
  @ApiOperation({ summary: 'Link deliverable to zones' })
  linkZones(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LinkZonesDto,
  ) {
    return this.deliverablesService.linkZones(id, dto.zoneIds);
  }

  @Post(':id/instantiate')
  @ApiOperation({ summary: 'Create assignment instances for linked zones' })
  instantiate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.deliverablesService.instantiate(id, user.id);
  }
}
