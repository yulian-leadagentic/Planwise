import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Res,
  Body,
  Query,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataImportMode, DataImportTarget } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';

import { ExcelParserService } from './excel-parser.service';
import { UsersImporterService } from './importers/users-importer.service';
import { EntityImporter } from './importers/importer.types';
import * as Sentry from '@sentry/node';

/**
 * REST surface for the bulk data-import feature. Wraps three importers
 * (M1: users; M2: partners; M3: contacts) behind one set of endpoints
 * — the `target` path-param tells the controller which importer to
 * route to. Per-entity permissions are applied via the dynamic guard
 * mapping at the bottom; each route only accepts the targets the
 * caller's permission covers.
 */
@ApiTags('Data Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('data-import')
export class DataImportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: ExcelParserService,
    private readonly usersImporter: UsersImporterService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Resolve the importer for a target. Throws 404 instead of 400 so the
   * route surface looks consistent ("no importer for X" = no resource),
   * and 501 for the M2/M3 targets that aren't shipped yet.
   */
  private getImporter(target: DataImportTarget): EntityImporter {
    switch (target) {
      case 'users':
        return this.usersImporter;
      case 'partners':
      case 'contacts':
        throw new BadRequestException(
          `Importer for "${target}" ships in M2/M3. Currently only "users" is supported.`,
        );
      default:
        throw new NotFoundException(`Unknown import target: ${target}`);
    }
  }

  /**
   * Returns true if the caller can use the importer for this target.
   * The permission for each target is a dedicated module — we check it
   * here rather than via @RequirePermissions because the target comes
   * from the URL param, not the route definition.
   */
  private assertCanImport(user: any, target: DataImportTarget) {
    const required = `data-import/${target}`;
    const hasIt = user?.roleModules?.some((rm: any) => {
      const route = rm.module?.route ?? '';
      return (route === required || route === `/${required}`) && rm.canWrite;
    });
    if (!hasIt) {
      throw new ForbiddenException(
        `You need "data-import/${target}" permission to import ${target}.`,
      );
    }
  }

  // ─── Template download ─────────────────────────────────────────────

  @Get('template/:target')
  @RequirePermissions({ module: 'data-import', action: 'read' })
  @ApiOperation({ summary: 'Download the Excel template for a target entity' })
  async getTemplate(
    @CurrentUser() user: any,
    @Param('target') target: DataImportTarget,
    @Res() res: Response,
  ) {
    this.assertCanImport(user, target);
    const importer = this.getImporter(target);
    const buf = await importer.generateTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="planwise-${target}-template.xlsx"`);
    res.send(buf);
  }

  // ─── Validate (no DB write) ────────────────────────────────────────

  @Post('validate/:target')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @RequirePermissions({ module: 'data-import', action: 'read' })
  @ApiOperation({ summary: 'Upload + validate without writing anything' })
  async validate(
    @CurrentUser() user: any,
    @Param('target') target: DataImportTarget,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
  ) {
    this.assertCanImport(user, target);
    if (!file) throw new BadRequestException('No file uploaded. Use the "file" form field.');

    const parsed = await this.parser.parse(file.buffer);
    const importer = this.getImporter(target);

    // Finance gate — the same NO_ADMIN_BYPASS rule we use elsewhere.
    const canSeeFinance = (user.roleModules ?? []).some((rm: any) => {
      const r = rm.module?.route ?? '';
      return (r === 'finance' || r === '/finance') && rm.canRead;
    });

    const results = await importer.validateRows(parsed.rows, { canSeeFinance });

    const summary = {
      total: results.length,
      validForInsert: results.filter((r) => r.errors.length === 0 && !r.conflictsWithExisting).length,
      conflictsExisting: results.filter((r) => r.errors.length === 0 && r.conflictsWithExisting).length,
      errors: results.filter((r) => r.errors.length > 0).length,
    };

    return {
      filename: file.originalname,
      fileHash: parsed.fileHash,
      headers: parsed.headers,
      expectedColumns: importer.templateColumns,
      canSeeFinance,
      summary,
      // Cap the response — for 10k rows the validation table on the UI
      // is virtualized but still shouldn't ship 10k rows in one JSON.
      // The wizard re-validates after the user re-uploads anyway.
      rows: results.slice(0, 500),
      truncated: results.length > 500,
    };
  }

  // ─── Commit (actually write) ───────────────────────────────────────

  @Post('commit/:target')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @RequirePermissions({ module: 'data-import', action: 'write' })
  @ApiOperation({ summary: 'Validate and persist. Returns the import record + summary.' })
  async commit(
    @CurrentUser() user: any,
    @Param('target') target: DataImportTarget,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
    @Body('mode') modeRaw?: string,
    @Body('notes') notes?: string,
  ) {
    this.assertCanImport(user, target);
    if (!file) throw new BadRequestException('No file uploaded.');

    const mode: DataImportMode = (modeRaw as DataImportMode) ?? 'insert';
    if (!['insert', 'upsert', 'update'].includes(mode)) {
      throw new BadRequestException(`Invalid mode "${modeRaw}". Use insert | upsert | update.`);
    }

    const parsed = await this.parser.parse(file.buffer);
    const importer = this.getImporter(target);

    // Duplicate-upload guard — same file by same user within 5 minutes
    // is almost always a double-click, not intent. Hard reject instead
    // of letting the second one go through and double-creating users.
    const recentDup = await this.prisma.dataImport.findFirst({
      where: {
        userId: user.id,
        target,
        fileHash: parsed.fileHash,
        startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (recentDup) {
      throw new BadRequestException(
        `You already uploaded this exact file at ${recentDup.startedAt.toISOString()} (import #${recentDup.id}). Wait 5 minutes or use a different file.`,
      );
    }

    const canSeeFinance = (user.roleModules ?? []).some((rm: any) => {
      const r = rm.module?.route ?? '';
      return (r === 'finance' || r === '/finance') && rm.canRead;
    });

    // Pre-validate every row before opening the import record so the
    // count we save is correct even when committing.
    const validated = await importer.validateRows(parsed.rows, { canSeeFinance });

    const importRecord = await this.prisma.dataImport.create({
      data: {
        userId: user.id,
        target,
        filename: file.originalname,
        fileHash: parsed.fileHash,
        mode,
        rowCount: validated.length,
        status: 'parsed',
        notes,
      },
    });

    let result;
    try {
      result = await importer.commit({
        importId: importRecord.id,
        rows: validated,
        mode,
        userId: user.id,
      });
    } catch (e: any) {
      // Catastrophic — mark the import failed but keep the row records
      // for diagnosis.
      await this.prisma.dataImport.update({
        where: { id: importRecord.id },
        data: { status: 'failed', finishedAt: new Date() },
      });
      throw e;
    }

    const status =
      result.errorCount === 0 && result.skippedCount === 0
        ? 'committed'
        : 'partial';

    const updated = await this.prisma.dataImport.update({
      where: { id: importRecord.id },
      data: {
        status,
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        skippedCount: result.skippedCount,
        errorCount: result.errorCount,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Audit trail — ONE summary row per generic-importer commit (users
    // and any future non-project-scoped target). projectId stays null:
    // these imports write global rows (users, partners) that don't
    // belong to a specific project's Activity tab. Uses `admin`
    // category — no `import` enum value; matches sso-admin /
    // drive-admin convention.
    try {
      await this.activityLog.write({
        category: 'admin',
        action: `import.${target}.committed`,
        actorUserId: user.id,
        projectId: null,
        entityType: 'data_import',
        entityId: updated.id,
        entityName: file.originalname,
        description: `Imported ${target} "${file.originalname}": ${result.createdCount} created, ${result.updatedCount} updated, ${result.skippedCount} skipped` +
          (result.errorCount > 0 ? `, ${result.errorCount} errors` : ''),
        metadata: {
          importId: updated.id,
          target,
          mode,
          created: result.createdCount,
          linked: result.updatedCount,
          skipped: result.skippedCount,
          errors: result.errorCount,
        },
      });
    } catch (e) { Sentry.captureException(e); /* swallow — audit failure never fails the commit */ }

    return { import: updated, summary: result };
  }

  // ─── History ───────────────────────────────────────────────────────

  @Get('history')
  @RequirePermissions({ module: 'data-import', action: 'read' })
  @ApiOperation({ summary: 'List imports the caller has run' })
  async history(@CurrentUser() user: any, @Query('target') target?: DataImportTarget) {
    // Admin (with the permission) sees everyone's history. Other roles
    // see only their own. We detect "admin" by role name — same
    // pattern as the rest of the app.
    const isAdmin = user.role?.name === 'Admin' || user.roleName === 'Admin';
    return this.prisma.dataImport.findMany({
      where: {
        ...(isAdmin ? {} : { userId: user.id }),
        ...(target ? { target } : {}),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
  }

  @Get('history/:id/rows')
  @RequirePermissions({ module: 'data-import', action: 'read' })
  @ApiOperation({ summary: 'Per-row outcome detail for one import (for error/result download)' })
  async historyRows(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const imp = await this.prisma.dataImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found.');
    const isAdmin = user.role?.name === 'Admin' || user.roleName === 'Admin';
    if (!isAdmin && imp.userId !== user.id) {
      throw new ForbiddenException('You can only view your own imports.');
    }
    return this.prisma.dataImportRow.findMany({
      where: { importId: id },
      orderBy: { rowIndex: 'asc' },
    });
  }

  // ─── Rollback ──────────────────────────────────────────────────────

  @Post('history/:id/rollback')
  @RequirePermissions({ module: 'data-import', action: 'delete' })
  @ApiOperation({ summary: 'Undo an import — delete created entities and restore updated ones' })
  async rollback(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const imp = await this.prisma.dataImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found.');

    const isAdmin = user.role?.name === 'Admin' || user.roleName === 'Admin';
    if (!isAdmin && imp.userId !== user.id) {
      throw new ForbiddenException('You can only roll back your own imports.');
    }
    if (imp.status === 'rolled_back') {
      throw new BadRequestException('This import has already been rolled back.');
    }
    if (imp.expiresAt && imp.expiresAt < new Date()) {
      throw new BadRequestException('This import is past its rollback window (30 days).');
    }

    const importer = this.getImporter(imp.target);
    const result = await importer.rollback(id);

    await this.prisma.dataImport.update({
      where: { id },
      data: { status: 'rolled_back', rolledBackAt: new Date() },
    });

    return { import: { id, status: 'rolled_back' }, ...result };
  }
}
