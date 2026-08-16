import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { CONTACT_FIELDS, ContactField } from './header-dictionary';

/**
 * BM2 · Contacts import wizard · Stage 3 — mapping-preset CRUD.
 *
 * A preset is a named `{ [field]: sourceHeaderText }` mapping the user
 * (or a system seed) has saved for reuse. §5 of the methodology
 * measured 72 unique shapes in the real folder, but the top ~12 shapes
 * cover the majority — seeded in `20260814100000_contacts_import_mapping_presets`
 * so most files are 0-click without any user work.
 *
 * The wizard applies a preset by matching its `mapping` header texts
 * against the CURRENT sheet's headers (normalized) — so a preset made
 * for one file works on any file whose column headers normalize to the
 * same set of names. When the current sheet's headers don't overlap
 * with the preset, the picker greys it out rather than applying a
 * mis-mapping.
 */
@Injectable()
export class ContactsMappingPresetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List presets for a `kind` (only 'contacts' today). Sorted by
   * system-first, name asc — the wizard renders system presets in a
   * pinned group above the user's own saved ones.
   */
  async list(kind: string) {
    if (!kind) throw new BadRequestException('kind is required');
    return this.prisma.importMappingPreset.findMany({
      where: { kind },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Create a preset. Users can save their own; system rows are only
   * created via the seed migration. The (kind, name) pair is unique so
   * "Save as preset" is idempotent — re-saving with the same name
   * updates the mapping rather than creating a duplicate.
   */
  async upsert(input: {
    id?: number;
    kind: string;
    name: string;
    description?: string | null;
    mapping: Record<string, string>;
    userId: number;
  }) {
    if (!input.kind) throw new BadRequestException('kind is required');
    if (!input.name?.trim()) throw new BadRequestException('name is required');

    const cleanMapping = validateMapping(input.mapping);
    const signature = mappingSignature(cleanMapping);

    if (input.id != null) {
      const existing = await this.prisma.importMappingPreset.findUnique({
        where: { id: input.id },
      });
      if (!existing) throw new NotFoundException(`preset ${input.id} not found`);
      if (existing.isSystem) {
        throw new ForbiddenException('system presets are read-only');
      }
      return this.prisma.importMappingPreset.update({
        where: { id: input.id },
        data: {
          name: input.name.trim(),
          description: input.description ?? null,
          mapping: cleanMapping as Prisma.InputJsonValue,
          signature: signature as Prisma.InputJsonValue,
        },
      });
    }

    try {
      return await this.prisma.importMappingPreset.create({
        data: {
          kind: input.kind,
          name: input.name.trim(),
          description: input.description ?? null,
          mapping: cleanMapping as Prisma.InputJsonValue,
          signature: signature as Prisma.InputJsonValue,
          createdBy: input.userId,
          isSystem: false,
        },
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `A preset named "${input.name.trim()}" already exists for ${input.kind}.`,
        );
      }
      throw err;
    }
  }

  async remove(id: number) {
    const existing = await this.prisma.importMappingPreset.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`preset ${id} not found`);
    if (existing.isSystem) throw new ForbiddenException('system presets cannot be deleted');
    await this.prisma.importMappingPreset.delete({ where: { id } });
    return { message: 'preset removed' };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Validate a user-supplied mapping. Rejects unknown canonical fields
 * (guards against a stale FE sending a "phone2" key we won't use), and
 * strips empty header values so an accidentally-blanked row in the UI
 * doesn't persist as `{ email: "" }`.
 */
function validateMapping(raw: Record<string, string>): Record<ContactField, string> {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('mapping must be an object');
  }
  const validFields = new Set<string>(CONTACT_FIELDS);
  const out: Partial<Record<ContactField, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!validFields.has(key)) {
      throw new BadRequestException(
        `Unknown mapping field "${key}". Allowed: ${CONTACT_FIELDS.join(', ')}`,
      );
    }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out[key as ContactField] = trimmed;
  }
  if (Object.keys(out).length === 0) {
    throw new BadRequestException('mapping is empty — set at least one field');
  }
  return out as Record<ContactField, string>;
}

function mappingSignature(mapping: Record<ContactField, string>): { fields: ContactField[] } {
  return {
    fields: (Object.keys(mapping) as ContactField[]).sort((a, b) => a.localeCompare(b)),
  };
}
