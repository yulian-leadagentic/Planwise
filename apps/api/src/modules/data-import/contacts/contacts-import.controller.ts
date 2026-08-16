import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RequirePermissions } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';

import { ContactsTriageService, TriageResult } from './triage.service';
import { ContactsHeaderDetectionService, SheetGrade } from './header-detection.service';
import { ContactsMappingPresetService } from './mapping-preset.service';

/**
 * BM2 · Contacts import wizard — the "contacts" sub-mode of the existing
 * /data-import scaffolding. Sits under `/data-import/contacts/*` so the
 * shared surfaces from `data-import.controller.ts` (job history,
 * rollback, permission modules) apply unchanged.
 *
 * Every route is gated by `data-import/contacts:write` — even the
 * read-shaped triage step. Rationale (same as the users flow's own
 * `assertCanImport`): a user without the write permission has no
 * legitimate reason to sniff files against the importer. Splitting the
 * workflow "triage without permission, then jump into commit with a
 * copy-pasted body" removes an audit signal for no upside.
 */
@ApiTags('Data Import — Contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('data-import/contacts')
export class ContactsImportController {
  constructor(
    private readonly triage: ContactsTriageService,
    private readonly headers: ContactsHeaderDetectionService,
    private readonly presets: ContactsMappingPresetService,
  ) {}

  /** Extra defense — the guard covers `data-import/contacts`; make sure
   *  the caller specifically has WRITE on that path (not merely READ). */
  private assertCanImport(user: any) {
    const has = (user?.roleModules ?? []).some((rm: any) => {
      const route = rm.module?.route ?? '';
      return (route === 'data-import/contacts' || route === '/data-import/contacts') && rm.canWrite;
    });
    if (!has) throw new ForbiddenException('You need "data-import/contacts" write permission.');
  }

  /**
   * Stage 1 — triage the uploaded file by magic bytes (NEVER by
   * extension), route it to a tolerant in-process reader (xlsx / xls /
   * csv / html-as-xlsx via SheetJS · docx via mammoth · pdf via
   * pdf-parse + RTL fix), and return the extracted sheets. True
   * non-data (images, draw.io, executables) is rejected here with a
   * human-readable reason — the wizard shows it verbatim.
   *
   * Response is intentionally chunky (whole extracted grid): the
   * subsequent stages (header detection, mapping, dedup, commit) accept
   * the same shape back so the pipeline is stateless server-side.
   */
  @Post('triage')
  @RequirePermissions({ module: 'data-import/contacts', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Sniff magic bytes + extract with a tolerant reader. Returns sheets for xlsx/xls/csv/html/docx, extracted lines + confidence for pdf, or a reject with reason for images/diagrams/binary.',
  })
  async triageFile(
    @CurrentUser() user: any,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
    @Body('filename') filenameOverride?: string,
  ): Promise<TriageResult> {
    this.assertCanImport(user);
    if (!file) {
      // Never a 500 — surface it as a rejection reason so the UI can
      // display it in the same place the byte-triage rejections appear.
      return { kind: 'reject', reason: 'no file was uploaded (use the "file" form field)' };
    }
    // Guard against unbounded uploads. The Multer module cap is 5 MB
    // in this codebase; keep this in sync so the reject message names
    // the same number the wizard shows on the drop-zone.
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.buffer.length > MAX_BYTES) {
      return {
        kind: 'reject',
        reason: `file is larger than ${Math.round(MAX_BYTES / (1024 * 1024))} MB — split it or contact support`,
      };
    }
    return this.triage.triage(file.buffer, filenameOverride ?? file.originalname);
  }

  /**
   * Stage 1 + Stage 2 combined — the wizard's real "upload" entry
   * point. Triages the file, and for every accepted sheet returns the
   * Stage 2 grade (header row + confidence + auto-suggested column
   * mapping). Rejects still surface with a reason.
   *
   * We ship this as a single endpoint (vs. triage-then-grade) because
   * the frontend needs both to render the picker in one paint — and
   * Stage 2 is cheap once the buffer is already parsed.
   */
  @Post('upload')
  @RequirePermissions({ module: 'data-import/contacts', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Stage 1 + Stage 2 — triage the upload, then per-sheet header detection with an auto-suggested column mapping. One round-trip; the client persists the returned sheets across the remaining wizard steps.',
  })
  async upload(
    @CurrentUser() user: any,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
    @Body('filename') filenameOverride?: string,
  ): Promise<UploadResponse> {
    this.assertCanImport(user);
    if (!file) {
      return {
        triage: { kind: 'reject', reason: 'no file was uploaded (use the "file" form field)' },
        grades: [],
      };
    }
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.buffer.length > MAX_BYTES) {
      return {
        triage: {
          kind: 'reject',
          reason: `file is larger than ${Math.round(MAX_BYTES / (1024 * 1024))} MB — split it or contact support`,
        },
        grades: [],
      };
    }
    const triage = await this.triage.triage(file.buffer, filenameOverride ?? file.originalname);
    if (triage.kind === 'reject') return { triage, grades: [] };
    const grades = this.headers.grade(triage.sheets);
    return { triage, grades };
  }
}

export interface UploadResponse {
  triage: TriageResult;
  grades: SheetGrade[];
}

// ─── Stage 3 — mapping presets ────────────────────────────────────────
// Mounted on a nested controller so the surface stays cohesive under
// /data-import/contacts/*. Reads are read-gated; writes/deletes gated
// like the rest of the wizard (write on data-import/contacts). The
// wizard's "Save as preset" and "Apply preset" round-trip through these.

@ApiTags('Data Import — Contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('data-import/contacts/mapping-presets')
export class ContactsMappingPresetController {
  constructor(private readonly presets: ContactsMappingPresetService) {}

  @Get()
  @RequirePermissions({ module: 'data-import/contacts', action: 'write' })
  @ApiOperation({
    summary:
      'List mapping presets for the contacts importer. System presets pinned first, then the user\'s saved ones.',
  })
  async list(@Query('kind') kind = 'contacts') {
    return this.presets.list(kind);
  }

  @Post()
  @RequirePermissions({ module: 'data-import/contacts', action: 'write' })
  @ApiOperation({
    summary:
      'Create or update a named mapping preset. (kind, name) is unique — re-saving with the same name replaces the mapping (idempotent "Save as preset").',
  })
  async upsert(
    @CurrentUser() user: any,
    @Body()
    body: {
      id?: number;
      kind?: string;
      name: string;
      description?: string | null;
      mapping: Record<string, string>;
    },
  ) {
    return this.presets.upsert({
      id: body.id,
      kind: body.kind ?? 'contacts',
      name: body.name,
      description: body.description,
      mapping: body.mapping,
      userId: user.id,
    });
  }

  @Delete(':id')
  @RequirePermissions({ module: 'data-import/contacts', action: 'delete' })
  @ApiOperation({ summary: 'Delete a preset. System presets are protected.' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.presets.remove(id);
  }
}
