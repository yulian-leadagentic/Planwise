import {
  Body,
  Controller,
  ForbiddenException,
  Post,
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
  constructor(private readonly triage: ContactsTriageService) {}

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
}
