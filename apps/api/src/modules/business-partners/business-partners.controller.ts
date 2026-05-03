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
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

import { BusinessPartnersService } from './business-partners.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { QueryBusinessPartnersDto } from './dto/query-business-partners.dto';
import { ImportBusinessPartnersDto } from './dto/import-business-partners.dto';

@ApiTags('Business Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(AuditInterceptor)
@Controller('business-partners')
export class BusinessPartnersController {
  constructor(private readonly service: BusinessPartnersService) {}

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List business partners (people + organizations) with filters' })
  findAll(@Query() query: QueryBusinessPartnersDto) {
    return this.service.findAll(query);
  }

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Create a business partner' })
  create(@Body() dto: CreateBusinessPartnerDto) {
    return this.service.create(dto);
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'Get a business partner with roles + relationships' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Update a business partner' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBusinessPartnerDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Soft-delete a business partner (blocked if a login user is attached)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  // ─── Role management ──────────────────────────────────────────────────
  @Post(':id/roles')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Add or update a business role for a partner' })
  addRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { roleTypeId: number; isPrimary?: boolean },
  ) {
    return this.service.addRole(id, body.roleTypeId, body.isPrimary ?? false);
  }

  @Delete(':id/roles/:roleId')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Remove a business role from a partner' })
  removeRole(
    @Param('id', ParseIntPipe) id: number,
    @Param('roleId', ParseIntPipe) roleId: number,
  ) {
    return this.service.removeRole(id, roleId);
  }

  // ─── CSV import ───────────────────────────────────────────────────────
  @Post('import')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        skipExisting: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
    },
  })
  @ApiOperation({
    summary:
      'Import partners from a CSV. Headers (case-insensitive): partner_type (required), first_name, last_name, company_name, tax_id, email, phone, mobile, address, website, notes, roles (CSV of role codes).',
  })
  importCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: ImportBusinessPartnersDto,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('CSV must be 5MB or smaller');
    }
    return this.service.importFromCsv(file.buffer, {
      skipExisting: body.skipExisting,
      dryRun: body.dryRun,
    });
  }
}
