import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { BillingsService } from './billings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateBillingDto } from './dto/create-billing.dto';

@ApiTags('Billings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('billings')
export class BillingsController {
  constructor(private readonly billingsService: BillingsService) {}

  @Post()
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Create a billing' })
  create(@CurrentUser() user: any, @Body() dto: CreateBillingDto) {
    return this.billingsService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'List billings with filters' })
  findAll(
    @Query('contractId') contractId?: number,
    @Query('status') status?: string,
  ) {
    return this.billingsService.findAll({ contractId, status });
  }

  @Get(':id')
  @RequirePermissions({ module: 'contracts', action: 'read' })
  @ApiOperation({ summary: 'Get billing by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.billingsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'contracts', action: 'write' })
  @ApiOperation({ summary: 'Update billing status' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.billingsService.update(id, body);
  }
}
