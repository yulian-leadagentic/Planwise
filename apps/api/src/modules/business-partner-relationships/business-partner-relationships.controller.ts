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
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RelationshipTarget } from '@prisma/client';

import { BusinessPartnerRelationshipsService } from './business-partner-relationships.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';
import { QueryRelationshipsDto } from './dto/query-relationships.dto';

@ApiTags('Business Partner Relationships')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(AuditInterceptor)
@Controller('business-partner-relationships')
export class BusinessPartnerRelationshipsController {
  constructor(private readonly service: BusinessPartnerRelationshipsService) {}

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List relationships with filters (sourcePartnerId / target / type / status)' })
  findAll(@Query() q: QueryRelationshipsDto) {
    return this.service.findAll(q);
  }

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Create a new relationship' })
  create(@Body() dto: CreateRelationshipDto) {
    return this.service.create(dto);
  }

  @Get('for-target')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List active relationships pointing to a specific target (e.g. project=42)' })
  forTarget(
    @Query('targetType') targetType: RelationshipTarget,
    @Query('targetId', ParseIntPipe) targetId: number,
  ) {
    return this.service.findForTarget(targetType, targetId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'Get a relationship by id' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Update a relationship' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRelationshipDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Delete a relationship (hard delete)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
