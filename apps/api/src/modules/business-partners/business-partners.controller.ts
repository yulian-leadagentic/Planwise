import {
  Controller,
  Get,
  Post,
  Put,
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
import { BpImportService, validateBpImportMapping, BpImportDecision, BpImportRow } from './bp-import.service';
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
  constructor(
    private readonly service: BusinessPartnersService,
    private readonly bpImport: BpImportService,
  ) {}

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

  // ─── Job Title (Profession) management ────────────────────────────────
  // Sets the partner's full list of job titles in one shot. Frontend sends
  // an array of profession ids (optionally with isPrimary on one). The
  // service diffs the current vs. desired set and adds/removes as needed.
  @Get(':id/professions')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: "List a partner's job titles (professions)" })
  listProfessions(@Param('id', ParseIntPipe) id: number) {
    return this.service.listProfessions(id);
  }

  @Put(':id/professions')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: "Set a partner's job titles (replaces the list)" })
  setProfessions(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { professionIds: number[]; primaryProfessionId?: number | null },
  ) {
    return this.service.setProfessions(id, body.professionIds ?? [], body.primaryProfessionId ?? null);
  }

  // ─── BM2 Phase D — Domains ────────────────────────────────────────────
  // Orgs may own multiple domains; the import dedup consults this list.
  // The drawer surfaces list + add + delete against these endpoints.
  @Get(':id/domains')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List domains owned by this BP (orgs only)' })
  listDomains(@Param('id', ParseIntPipe) id: number) {
    return this.service.listDomains(id);
  }

  @Post(':id/domains')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Attach a new domain to this BP' })
  addDomain(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { domain: string },
  ) {
    return this.service.addDomain(id, body.domain);
  }

  @Delete(':id/domains/:domainId')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Detach a domain from this BP' })
  removeDomain(
    @Param('id', ParseIntPipe) id: number,
    @Param('domainId', ParseIntPipe) domainId: number,
  ) {
    return this.service.removeDomain(id, domainId);
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

  // ─── BM2 Phase E — Excel BP + Contacts import wizard ─────────────────
  // Three endpoints follow the wizard's four steps (upload+parse,
  // column-map, preview, commit — commit accepts the mapping + rows +
  // per-row decisions from the conflict-resolution step):
  //
  //   POST /business-partners/bp-import/parse     (multipart file)
  //   POST /business-partners/bp-import/preview   (rows + mapping)
  //   POST /business-partners/bp-import/commit    (rows + mapping + decisions)
  //
  // The heavier /data-import pipeline (job history, template
  // generation, per-target Excel generation) is intentionally NOT
  // reused — bp-contacts-design.md's wizard is stateless from the
  // server's view: the client keeps the row set in state across steps
  // and sends it back on preview / commit.

  @Post('bp-import/parse')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Parse an xlsx and return headers + rows + auto-detected column mapping' })
  async bpImportParse(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.bpImport.parse(file.buffer);
  }

  @Post('bp-import/preview')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Resolve org + contact per row against existing BPs; no writes' })
  async bpImportPreview(
    @Body() body: { headers: string[]; rows: BpImportRow[]; mapping: unknown },
  ) {
    if (!Array.isArray(body.rows)) throw new BadRequestException('rows must be an array');
    if (!Array.isArray(body.headers)) throw new BadRequestException('headers must be an array');
    return this.bpImport.preview({
      headers: body.headers,
      rows: body.rows,
      mapping: validateBpImportMapping(body.mapping),
    });
  }

  @Post('bp-import/commit')
  @RequirePermissions({ module: 'partners', action: 'write' })
  @ApiOperation({ summary: 'Persist the imported orgs + contacts (respects per-row decisions)' })
  async bpImportCommit(
    @Body() body: {
      headers: string[];
      rows: BpImportRow[];
      mapping: unknown;
      decisions?: BpImportDecision[];
      stopOnError?: boolean;
    },
  ) {
    if (!Array.isArray(body.rows)) throw new BadRequestException('rows must be an array');
    if (!Array.isArray(body.headers)) throw new BadRequestException('headers must be an array');
    return this.bpImport.commit({
      headers: body.headers,
      rows: body.rows,
      mapping: validateBpImportMapping(body.mapping),
      decisions: Array.isArray(body.decisions) ? body.decisions : undefined,
      stopOnError: !!body.stopOnError,
    });
  }
}
