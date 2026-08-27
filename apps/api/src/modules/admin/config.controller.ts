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
  Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Admin - Config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/config')
export class ConfigController {
  constructor(private prisma: PrismaService) {}

  // Project Types
  @Get('project-types')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List project types' })
  async getProjectTypes() {
    return this.prisma.projectType.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { projects: true } } },
    });
  }

  @Post('project-types')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create project type' })
  async createProjectType(@Body() body: { name: string; code?: string; color?: string }) {
    return this.prisma.projectType.create({ data: { name: body.name, code: body.code || null, color: body.color || null } });
  }

  @Patch('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update project type' })
  async updateProjectType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; code?: string; color?: string },
  ) {
    return this.prisma.projectType.update({
      where: { id },
      data: { name: body.name, code: body.code, color: body.color },
    });
  }

  @Delete('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete project type' })
  async deleteProjectType(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.projectType.delete({ where: { id } });
    return { message: 'Project type deleted' };
  }

  // Modules (system navigation/permissions)
  @Get('modules')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List system modules' })
  async getModules() {
    return this.prisma.module.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        children: { orderBy: { sortOrder: 'asc' } },
      },
      where: { parentId: null },
    });
  }

  // Team Templates
  @Get('team-templates')
  @RequirePermissions({ module: 'templates/team', action: 'read' })
  async getTeamTemplates() {
    return this.prisma.teamTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        members: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, userType: true, position: true } } },
        },
        _count: { select: { members: true } },
      },
    });
  }

  @Post('team-templates')
  @RequirePermissions({ module: 'templates/team', action: 'write' })
  async createTeamTemplate(@Body() body: { name: string }, @Req() req: any) {
    return this.prisma.teamTemplate.create({
      data: { name: body.name, createdBy: req.user?.id || 1 },
      include: { members: { include: { user: true } }, _count: { select: { members: true } } },
    });
  }

  @Delete('team-templates/:id')
  @RequirePermissions({ module: 'templates/team', action: 'delete' })
  async deleteTeamTemplate(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.teamTemplateMember.deleteMany({ where: { teamTemplateId: id } });
    await this.prisma.teamTemplate.delete({ where: { id } });
    return { message: 'Team template deleted' };
  }

  @Post('team-templates/:id/members')
  @RequirePermissions({ module: 'templates/team', action: 'write' })
  async addTeamTemplateMember(
    @Param('id', ParseIntPipe) templateId: number,
    @Body() body: { userId: number; role?: string },
  ) {
    return this.prisma.teamTemplateMember.create({
      data: { teamTemplateId: templateId, userId: body.userId, role: body.role || null },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, userType: true } } },
    });
  }

  @Delete('team-template-members/:id')
  @RequirePermissions({ module: 'templates/team', action: 'delete' })
  async removeTeamTemplateMember(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.teamTemplateMember.delete({ where: { id } });
    return { message: 'Member removed' };
  }

  // Departments
  @Get('departments')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List departments' })
  async getDepartments() {
    return this.prisma.department.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { projects: true } } },
    });
  }

  @Post('departments')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create department' })
  async createDepartment(@Body() body: { name: string; code?: string }) {
    return this.prisma.department.create({ data: { name: body.name, code: body.code || null } });
  }

  @Patch('departments/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update department' })
  async updateDepartment(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string; code?: string }) {
    return this.prisma.department.update({ where: { id }, data: body });
  }

  @Delete('departments/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete department' })
  async deleteDepartment(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.department.delete({ where: { id } });
    return { message: 'Department deleted' };
  }

  // Professions
  @Get('professions')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List professions' })
  async getProfessions() {
    return this.prisma.profession.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Post('professions')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create profession' })
  async createProfession(@Body() body: { name: string }) {
    const count = await this.prisma.profession.count();
    return this.prisma.profession.create({ data: { name: body.name, sortOrder: count + 1 } });
  }

  @Patch('professions/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update profession' })
  async updateProfession(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string }) {
    return this.prisma.profession.update({ where: { id }, data: body });
  }

  @Delete('professions/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete profession' })
  async deleteProfession(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.profession.delete({ where: { id } });
    return { message: 'Profession deleted' };
  }

  // Project Role Templates
  @Get('project-roles')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List project role templates' })
  async getProjectRoles() {
    return this.prisma.projectRoleTemplate.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Post('project-roles')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create project role template' })
  async createProjectRole(@Body() body: { name: string }) {
    const count = await this.prisma.projectRoleTemplate.count();
    return this.prisma.projectRoleTemplate.create({ data: { name: body.name, sortOrder: count + 1 } });
  }

  @Patch('project-roles/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update project role template' })
  async updateProjectRole(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string }) {
    return this.prisma.projectRoleTemplate.update({ where: { id }, data: body });
  }

  @Delete('project-roles/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete project role template' })
  async deleteProjectRole(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.projectRoleTemplate.delete({ where: { id } });
    return { message: 'Project role deleted' };
  }

  // Zone Types — editable presentation metadata for the ZoneType enum.
  // The enum (site/building/level/floor/wing/section/area/zone) is the
  // source of truth. Admins can customise label/color/icon/sortOrder
  // and DELETE a meta row so the type stops appearing in admin / pickers.
  // Adding new types requires extending the enum, so POST is intentionally
  // absent. Deletion only removes the metadata — existing zones that
  // reference the enum value continue to render with a fallback label.
  @Get('zone-types')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List zone type metadata' })
  async getZoneTypes() {
    return this.prisma.zoneTypeMeta.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  }

  @Patch('zone-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update zone type metadata (label/color/icon/sortOrder)' })
  async updateZoneType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { label?: string; color?: string; icon?: string | null; sortOrder?: number },
  ) {
    return this.prisma.zoneTypeMeta.update({
      where: { id },
      data: {
        label: body.label,
        color: body.color,
        icon: body.icon === null ? null : body.icon,
        sortOrder: body.sortOrder,
      },
    });
  }

  @Delete('zone-types/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete zone type metadata (enum value remains valid)' })
  async deleteZoneType(@Param('id', ParseIntPipe) id: number) {
    // Hard-deletes only the meta row; the enum value (site/building/etc.)
    // is unchanged and any existing zones that reference it keep working.
    // To "restore" a deleted meta row, an admin would re-seed via SQL —
    // there's no POST because new enum values require a migration.
    await this.prisma.zoneTypeMeta.delete({ where: { id } });
    return { message: 'Zone type metadata deleted' };
  }

  // Currencies — ISO-4217 catalog. Seeded with ILS/USD/EUR; admins can
  // add or deactivate. Code is the primary key (immutable on update).
  @Get('currencies')
  @RequirePermissions({ module: 'admin', action: 'read' })
  async getCurrencies() {
    return this.prisma.currency.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  @Post('currencies')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async createCurrency(
    @Body() body: { code: string; name: string; symbol?: string; decimals?: number; sortOrder?: number },
  ) {
    return this.prisma.currency.create({
      data: {
        code: body.code.toUpperCase(),
        name: body.name,
        symbol: body.symbol ?? null,
        decimals: body.decimals ?? 2,
        sortOrder: body.sortOrder ?? 0,
      },
    });
  }

  @Patch('currencies/:code')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async updateCurrency(
    @Param('code') code: string,
    @Body() body: { name?: string; symbol?: string | null; decimals?: number; isActive?: boolean; sortOrder?: number },
  ) {
    return this.prisma.currency.update({
      where: { code: code.toUpperCase() },
      data: {
        name: body.name,
        symbol: body.symbol === null ? null : body.symbol,
        decimals: body.decimals,
        isActive: body.isActive,
        sortOrder: body.sortOrder,
      },
    });
  }

  @Delete('currencies/:code')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  async deleteCurrency(@Param('code') code: string) {
    await this.prisma.currency.delete({ where: { code: code.toUpperCase() } });
    return { message: 'Currency deleted' };
  }

  // Seniority levels — user-managed ladder (Junior / Mid / Senior / …).
  // No seed; each org defines its own. Used by EmployeeRole + RoleCostRate.
  @Get('seniority-levels')
  @RequirePermissions({ module: 'admin', action: 'read' })
  async getSeniorityLevels() {
    return this.prisma.seniorityLevel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post('seniority-levels')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async createSeniorityLevel(
    @Body() body: {
      code: string;
      name: string;
      sortOrder?: number;
      defaultHourlyCost?: number | string | null;
      currency?: string | null;
    },
  ) {
    const count = await this.prisma.seniorityLevel.count();
    return this.prisma.seniorityLevel.create({
      data: {
        code: body.code.trim(),
        name: body.name.trim(),
        sortOrder: body.sortOrder ?? (count + 1) * 10,
        defaultHourlyCost:
          body.defaultHourlyCost == null || body.defaultHourlyCost === ''
            ? null
            : new Prisma.Decimal(body.defaultHourlyCost as any),
        currency: body.currency?.trim().toUpperCase() || null,
      },
    });
  }

  @Patch('seniority-levels/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async updateSeniorityLevel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      code?: string;
      name?: string;
      sortOrder?: number;
      isActive?: boolean;
      defaultHourlyCost?: number | string | null;
      currency?: string | null;
    },
  ) {
    return this.prisma.seniorityLevel.update({
      where: { id },
      data: {
        code: body.code?.trim(),
        name: body.name?.trim(),
        sortOrder: body.sortOrder,
        isActive: body.isActive,
        defaultHourlyCost:
          body.defaultHourlyCost === undefined
            ? undefined
            : body.defaultHourlyCost === null || body.defaultHourlyCost === ''
              ? null
              : new Prisma.Decimal(body.defaultHourlyCost as any),
        currency:
          body.currency === undefined ? undefined : (body.currency?.trim().toUpperCase() || null),
      },
    });
  }

  @Delete('seniority-levels/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  async deleteSeniorityLevel(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.seniorityLevel.delete({ where: { id } });
    return { message: 'Seniority level deleted' };
  }

  // ─── Disciplines (BM2 QA-2 Commit 4, 2026-08-27) ───────────────────
  // User-managed catalog of contact disciplines (Architecture / MEP /
  // Structural / …). Purely INFORMATIONAL — feeds display + search on
  // the Contacts list; never gates project-role eligibility (that lives
  // on `requiredPartnerRoleCode` + `requiredProfessionIds`).
  //
  // Empty by default; each org fills the catalog to match how they
  // organise their contact directory. The Contacts create form + drawer
  // read this list to render a Discipline picker.

  @Get('disciplines')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List disciplines' })
  async getDisciplines() {
    return this.prisma.discipline.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post('disciplines')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create discipline' })
  async createDiscipline(
    @Body() body: { code: string; name: string; nameHe?: string | null; sortOrder?: number },
  ) {
    const count = await this.prisma.discipline.count();
    return this.prisma.discipline.create({
      data: {
        code: body.code.trim(),
        name: body.name.trim(),
        nameHe: body.nameHe?.trim() || null,
        sortOrder: body.sortOrder ?? (count + 1) * 10,
      },
    });
  }

  @Patch('disciplines/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update discipline' })
  async updateDiscipline(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      code?: string;
      name?: string;
      nameHe?: string | null;
      sortOrder?: number;
      isActive?: boolean;
    },
  ) {
    return this.prisma.discipline.update({
      where: { id },
      data: {
        code: body.code?.trim(),
        name: body.name?.trim(),
        // Explicit-null clears the Hebrew name; omitting keeps it.
        nameHe: body.nameHe === undefined ? undefined : (body.nameHe?.trim() || null),
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }

  @Delete('disciplines/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete discipline (BPs referencing it are set to null)' })
  async deleteDiscipline(@Param('id', ParseIntPipe) id: number) {
    // BP.disciplineId FK is ON DELETE SET NULL — legacy contacts that
    // reference this discipline stay in the database, just without a
    // discipline classification.
    await this.prisma.discipline.delete({ where: { id } });
    return { message: 'Discipline deleted' };
  }

  // ─── Time-log note phrases (Tier C #9b, 2026-06-30) ────────────────
  // Admin-curated pool of description snippets. GET returns active
  // rows only for pickers; admin CRUD sees everything.

  @Get('time-note-phrases')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List time-log preset phrases' })
  async getTimeNotePhrases() {
    return this.prisma.timeNotePhrase.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  // Open to any authenticated user so the picker on the time-entry
  // form can render without needing admin:read. Returns active only.
  @Get('time-note-phrases/active')
  @ApiOperation({ summary: 'Active phrases, for the time-entry picker' })
  async getActiveTimeNotePhrases() {
    return this.prisma.timeNotePhrase.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, text: true },
    });
  }

  @Post('time-note-phrases')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create a time-log preset phrase' })
  async createTimeNotePhrase(@Body() body: { text: string; sortOrder?: number; isActive?: boolean }) {
    return this.prisma.timeNotePhrase.create({
      data: {
        text: body.text,
        sortOrder: body.sortOrder ?? 0,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Patch('time-note-phrases/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update a time-log preset phrase' })
  async updateTimeNotePhrase(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { text?: string; sortOrder?: number; isActive?: boolean },
  ) {
    return this.prisma.timeNotePhrase.update({
      where: { id },
      data: body,
    });
  }

  @Delete('time-note-phrases/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete a time-log preset phrase' })
  async deleteTimeNotePhrase(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.timeNotePhrase.delete({ where: { id } });
    return { message: 'Phrase deleted' };
  }
}
