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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PartnerRelationshipsService } from './partner-relationships.service';

@ApiTags('Partner Relationships')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('partner-relationships')
export class PartnerRelationshipsController {
  constructor(private readonly service: PartnerRelationshipsService) {}

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List party↔party relationships (party_a → party_b)' })
  list(
    @Query('partyAId') partyAId?: string,
    @Query('partyBId') partyBId?: string,
    @Query('anyPartyId') anyPartyId?: string,
    @Query('typeCode') typeCode?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.service.list({
      partyAId: partyAId ? Number(partyAId) : undefined,
      partyBId: partyBId ? Number(partyBId) : undefined,
      anyPartyId: anyPartyId ? Number(anyPartyId) : undefined,
      typeCode: typeCode || undefined,
      activeOnly: activeOnly == null ? true : activeOnly !== 'false',
    });
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.service.create(body, user.id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Soft-end (sets valid_to=now); history preserved' })
  remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id, user.id);
  }
}
