import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, PartnerType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { QueryBusinessPartnersDto } from './dto/query-business-partners.dto';

const partnerInclude = {
  roles: { include: { roleType: true } },
  outgoingRelationships: { include: { relationshipType: true } },
  user: { select: { id: true, isActive: true, lastLoginAt: true, roleId: true } },
} as const;

function toDisplayName(dto: { partnerType: PartnerType; firstName?: string | null; lastName?: string | null; companyName?: string | null; displayName?: string | null }): string {
  if (dto.displayName?.trim()) return dto.displayName.trim();
  if (dto.partnerType === 'person') {
    return `${dto.firstName ?? ''} ${dto.lastName ?? ''}`.trim() || '(unnamed)';
  }
  return dto.companyName?.trim() || '(unnamed)';
}

@Injectable()
export class BusinessPartnersService {
  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────────────────

  async findAll(query: QueryBusinessPartnersDto) {
    const where: Prisma.BusinessPartnerWhereInput = { deletedAt: null };

    if (query.partnerType) where.partnerType = query.partnerType;
    if (query.status) where.status = query.status;

    if (query.roleType) {
      where.roles = {
        some: { roleType: { code: query.roleType } },
      };
    }

    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { displayName: { contains: s } },
        { email:       { contains: s } },
        { companyName: { contains: s } },
        { phone:       { contains: s } },
        { mobile:      { contains: s } },
      ];
    }

    const page = query.page ?? 1;
    const perPage = query.perPage ?? 50;

    const [data, total] = await Promise.all([
      this.prisma.businessPartner.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: [{ partnerType: 'asc' }, { displayName: 'asc' }],
        include: partnerInclude,
      }),
      this.prisma.businessPartner.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findOne(id: number) {
    const bp = await this.prisma.businessPartner.findFirst({
      where: { id, deletedAt: null },
      include: partnerInclude,
    });
    if (!bp) throw new NotFoundException('Business partner not found');
    return bp;
  }

  async create(dto: CreateBusinessPartnerDto) {
    if (dto.email) {
      // Global uniqueness across all partner_types — caught by DB unique
      // index too, but we want a friendly error.
      const dup = await this.prisma.businessPartner.findFirst({
        where: { email: dto.email, deletedAt: null },
      });
      if (dup) {
        throw new ConflictException(
          `A business partner with email "${dto.email}" already exists (id=${dup.id}). Reuse it instead of creating a duplicate.`,
        );
      }
    }

    if (dto.partnerType === 'organization' && !dto.companyName?.trim() && !dto.displayName?.trim()) {
      throw new BadRequestException('Organization partners require companyName or displayName');
    }
    if (dto.partnerType === 'person' && !dto.firstName?.trim() && !dto.lastName?.trim() && !dto.displayName?.trim()) {
      throw new BadRequestException('Person partners require firstName/lastName or displayName');
    }

    const bp = await this.prisma.businessPartner.create({
      data: {
        partnerType: dto.partnerType,
        displayName: toDisplayName(dto),
        firstName: dto.partnerType === 'person' ? dto.firstName ?? null : null,
        lastName: dto.partnerType === 'person' ? dto.lastName ?? null : null,
        companyName: dto.companyName ?? null,
        taxId: dto.taxId ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        mobile: dto.mobile ?? null,
        address: dto.address ?? null,
        website: dto.website ?? null,
        notes: dto.notes ?? null,
        source: dto.source ?? 'manual',
        roles:
          dto.initialRoleTypeIds && dto.initialRoleTypeIds.length > 0
            ? {
                createMany: {
                  data: [...new Set(dto.initialRoleTypeIds)].map((roleTypeId) => ({
                    roleTypeId,
                    isPrimary: false,
                  })),
                  skipDuplicates: true,
                },
              }
            : undefined,
      },
      include: partnerInclude,
    });

    return bp;
  }

  async update(id: number, dto: UpdateBusinessPartnerDto) {
    const existing = await this.findOne(id);

    if (dto.email && dto.email !== existing.email) {
      const dup = await this.prisma.businessPartner.findFirst({
        where: { email: dto.email, deletedAt: null, id: { not: id } },
      });
      if (dup) {
        throw new ConflictException(
          `Email "${dto.email}" is already used by another business partner (id=${dup.id}).`,
        );
      }
    }

    // Recompute displayName if any of its inputs changed and the caller
    // didn't pass an explicit one.
    const displayName =
      dto.displayName?.trim() ??
      (dto.firstName !== undefined || dto.lastName !== undefined || dto.companyName !== undefined
        ? toDisplayName({
            partnerType: existing.partnerType,
            firstName: dto.firstName ?? existing.firstName,
            lastName: dto.lastName ?? existing.lastName,
            companyName: dto.companyName ?? existing.companyName,
          })
        : undefined);

    return this.prisma.businessPartner.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        companyName: dto.companyName,
        taxId: dto.taxId,
        email: dto.email,
        phone: dto.phone,
        mobile: dto.mobile,
        address: dto.address,
        website: dto.website,
        notes: dto.notes,
        status: dto.status,
        ...(displayName !== undefined ? { displayName } : {}),
      },
      include: partnerInclude,
    });
  }

  /**
   * Soft delete. We deliberately do NOT cascade out to BPs that have an
   * attached User row — block that path so callers don't accidentally make
   * a live login user orphaned. The user can be deleted first via
   * /users/:id, which nulls business_partner_id on the User side.
   */
  async remove(id: number) {
    const bp = await this.prisma.businessPartner.findFirst({
      where: { id, deletedAt: null },
      include: { user: { select: { id: true, isActive: true } } },
    });
    if (!bp) throw new NotFoundException('Business partner not found');
    if (bp.user) {
      throw new BadRequestException(
        `This business partner is linked to a login user (user id=${bp.user.id}). Deactivate the user first, or delete the user to detach.`,
      );
    }
    await this.prisma.businessPartner.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Business partner removed' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Role management
  // ─────────────────────────────────────────────────────────────────────────

  async addRole(bpId: number, roleTypeId: number, isPrimary = false) {
    await this.findOne(bpId); // existence check + 404
    const roleType = await this.prisma.partnerRoleType.findUnique({ where: { id: roleTypeId } });
    if (!roleType) throw new NotFoundException('Role type not found');

    return this.prisma.businessPartnerRole.upsert({
      where: { businessPartnerId_roleTypeId: { businessPartnerId: bpId, roleTypeId } },
      update: { isPrimary },
      create: { businessPartnerId: bpId, roleTypeId, isPrimary },
      include: { roleType: true },
    });
  }

  async removeRole(bpId: number, roleId: number) {
    const role = await this.prisma.businessPartnerRole.findFirst({
      where: { id: roleId, businessPartnerId: bpId },
    });
    if (!role) throw new NotFoundException('Role not found on this partner');
    await this.prisma.businessPartnerRole.delete({ where: { id: roleId } });
    return { message: 'Role removed' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CSV import
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse + import a CSV. Expected columns (case-insensitive, any order):
   *   partner_type   — 'person' | 'organization' (required)
   *   first_name     — for persons
   *   last_name      — for persons
   *   company_name   — for organizations (or person's employer)
   *   tax_id
   *   email
   *   phone
   *   mobile
   *   address
   *   website
   *   notes
   *   roles          — comma-separated role codes (e.g. "employee,consultant")
   *
   * Empty rows are skipped. Rows with parse errors are reported but don't
   * abort the import — successful rows still commit (each row in its own tx).
   */
  async importFromCsv(
    csvBuffer: Buffer,
    options: { skipExisting?: boolean; dryRun?: boolean; userEmail?: string } = {},
  ): Promise<{
    summary: { total: number; created: number; skipped: number; errors: number };
    errors: { row: number; reason: string }[];
    created: { row: number; id: number; displayName: string }[];
  }> {
    const text = csvBuffer.toString('utf8').replace(/^﻿/, ''); // strip BOM
    const rows = this.parseCsv(text);
    if (rows.length === 0) {
      return { summary: { total: 0, created: 0, skipped: 0, errors: 0 }, errors: [], created: [] };
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const required = ['partner_type'];
    for (const col of required) {
      if (!header.includes(col)) {
        throw new BadRequestException(`CSV must include a "${col}" column. Found: ${header.join(', ')}`);
      }
    }

    const idx = (col: string) => header.indexOf(col);
    const get = (row: string[], col: string) => {
      const i = idx(col);
      return i >= 0 ? (row[i] ?? '').trim() : '';
    };

    // Pre-load role types so we can validate "roles" cells
    const roleTypes = await this.prisma.partnerRoleType.findMany();
    const roleTypeByCode = new Map(roleTypes.map((rt) => [rt.code, rt.id]));

    const errors: { row: number; reason: string }[] = [];
    const created: { row: number; id: number; displayName: string }[] = [];
    let skipped = 0;

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1; // 1-based, with header on line 1
      const row = rows[i];
      if (row.every((cell) => !cell?.trim())) continue;

      const partnerType = get(row, 'partner_type').toLowerCase();
      if (partnerType !== 'person' && partnerType !== 'organization') {
        errors.push({ row: rowNum, reason: `partner_type must be "person" or "organization" (got "${partnerType}")` });
        continue;
      }

      const email = get(row, 'email') || null;
      const firstName = get(row, 'first_name') || null;
      const lastName = get(row, 'last_name') || null;
      const companyName = get(row, 'company_name') || null;

      // Basic per-type validation
      if (partnerType === 'person' && !firstName && !lastName) {
        errors.push({ row: rowNum, reason: 'Person requires first_name or last_name' });
        continue;
      }
      if (partnerType === 'organization' && !companyName) {
        errors.push({ row: rowNum, reason: 'Organization requires company_name' });
        continue;
      }

      // Dedupe by email
      if (email) {
        const dup = await this.prisma.businessPartner.findFirst({
          where: { email, deletedAt: null },
        });
        if (dup) {
          if (options.skipExisting) {
            skipped++;
            continue;
          }
          errors.push({ row: rowNum, reason: `Email "${email}" already exists (id=${dup.id})` });
          continue;
        }
      }

      // Parse role codes
      const rolesCell = get(row, 'roles');
      const roleIds: number[] = [];
      if (rolesCell) {
        const codes = rolesCell.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        for (const code of codes) {
          const id = roleTypeByCode.get(code);
          if (id) roleIds.push(id);
          else errors.push({ row: rowNum, reason: `Unknown role code "${code}" — skipped` });
        }
      }

      if (options.dryRun) {
        created.push({ row: rowNum, id: -1, displayName: this.computeDisplay({ partnerType, firstName, lastName, companyName }) });
        continue;
      }

      try {
        const bp = await this.prisma.businessPartner.create({
          data: {
            partnerType: partnerType as any,
            displayName: this.computeDisplay({ partnerType, firstName, lastName, companyName }),
            firstName,
            lastName,
            companyName,
            taxId: get(row, 'tax_id') || null,
            email,
            phone: get(row, 'phone') || null,
            mobile: get(row, 'mobile') || null,
            address: get(row, 'address') || null,
            website: get(row, 'website') || null,
            notes: get(row, 'notes') || null,
            source: 'import',
            roles:
              roleIds.length > 0
                ? {
                    createMany: {
                      data: [...new Set(roleIds)].map((roleTypeId) => ({ roleTypeId, isPrimary: false })),
                      skipDuplicates: true,
                    },
                  }
                : undefined,
          },
        });
        created.push({ row: rowNum, id: bp.id, displayName: bp.displayName });
      } catch (err: any) {
        errors.push({ row: rowNum, reason: err?.message ?? 'Unknown error' });
      }
    }

    return {
      summary: {
        total: rows.length - 1,
        created: created.length,
        skipped,
        errors: errors.length,
      },
      errors,
      created,
    };
  }

  // RFC4180-ish CSV parser — handles quoted fields with embedded commas,
  // escaped quotes ("" → "), and CRLF or LF line endings.
  private parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        continue;
      }
      if (ch === '\r') {
        if (next === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        continue;
      }
      field += ch;
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  private computeDisplay(o: { partnerType: string; firstName?: string | null; lastName?: string | null; companyName?: string | null }): string {
    if (o.partnerType === 'person') {
      return `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || '(unnamed)';
    }
    return o.companyName?.trim() || '(unnamed)';
  }
}
