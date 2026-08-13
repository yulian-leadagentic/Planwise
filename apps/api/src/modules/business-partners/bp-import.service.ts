import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ExcelParserService } from '../data-import/excel-parser.service';
import {
  BusinessPartnersService,
  extractEmailDomain,
  PERSONAL_EMAIL_DOMAIN_FALLBACK,
} from './business-partners.service';

/**
 * BM2 Phase E — Excel Business Partners + Contacts import.
 *
 * Ships the workflow defined in docs/bm2/bp-contacts-design.md:
 *   • Upload + column mapping — headers → { company, contactName,
 *     mobile, phone, email, address, roleOrDiscipline }.
 *   • Resolve/dedup — domain-first (respecting the personal-domain
 *     rule), then normalized company name. Personal-email rows route
 *     to conflict resolution.
 *   • Preview — per-row action (create BP, link existing, needs decision).
 *   • Commit — creates missing orgs + person contacts, links each
 *     contact to its org via the worker_of party↔party edge. Idempotent
 *     when the same file is re-uploaded (dedup uses the same rules).
 *
 * The wizard's "Attach to this project" step is deliberately NOT part of
 * this service — that's a separate follow-up because it needs a UI
 * project picker; the backend endpoints below already return the
 * created BP ids so the caller can wire up ProjectPartnerRole rows if
 * it wants to.
 */

/** The wizard's canonical field set — every mapping key must be one of these. */
export const BP_IMPORT_FIELDS = [
  'company',
  'contactName',
  'contactFirstName',
  'contactLastName',
  'email',
  'phone',
  'mobile',
  'address',
  'roleOrDiscipline',
  'website',
  'notes',
] as const;
export type BpImportField = typeof BP_IMPORT_FIELDS[number];

export type BpImportMapping = Partial<Record<BpImportField, string>>;

export interface BpImportRow {
  /** 1-based data row index in the source sheet (row 1 is the header). */
  rowNum: number;
  /** Raw sheet values keyed by header text. */
  raw: Record<string, string>;
}

/**
 * Per-row resolution surfaced in the preview step.
 * `orgAction` = how the org side would be persisted; `contactAction` = the person.
 */
export interface BpImportRowResolution {
  rowNum: number;
  // Normalised values pulled from the row via the mapping.
  values: {
    company: string | null;
    contactName: string | null;
    email: string | null;
    domain: string | null;
    isPersonalDomain: boolean;
    phone: string | null;
    mobile: string | null;
    address: string | null;
    roleOrDiscipline: string | null;
    website: string | null;
    notes: string | null;
  };
  org: {
    /** 'link' = matched an existing BP · 'create' = will make a new BP · 'skip' = no company info · 'conflict' = ambiguous */
    action: 'link' | 'create' | 'skip' | 'conflict';
    reason: string;
    matchedBpId?: number;
    matchedBpName?: string;
    matchReason?: 'domain' | 'name';
  };
  contact: {
    /** 'link' = matched an existing person by email · 'create' = new person · 'skip' = no contact info */
    action: 'link' | 'create' | 'skip';
    reason: string;
    matchedBpId?: number;
    matchedBpName?: string;
  };
  errors: string[];
  warnings: string[];
}

export interface BpImportPreview {
  headers: string[];
  mapping: BpImportMapping;
  suggestedMapping: BpImportMapping;
  rows: BpImportRow[];
  resolutions: BpImportRowResolution[];
  summary: {
    totalRows: number;
    orgsToCreate: number;
    orgsToLink: number;
    orgConflicts: number;
    contactsToCreate: number;
    contactsToLink: number;
    contactsSkipped: number;
    errorRows: number;
  };
}

/**
 * Per-row commit decision. When omitted, the resolution's suggested
 * action is used. `orgAction: 'link'` requires `orgBpId`; the wizard
 * fills this from the conflict-resolution step.
 */
export interface BpImportDecision {
  rowNum: number;
  orgAction?: 'link' | 'create' | 'skip';
  orgBpId?: number;
  contactAction?: 'link' | 'create' | 'skip';
  contactBpId?: number;
}

export interface BpImportCommitResult {
  summary: {
    orgsCreated: number;
    orgsLinked: number;
    contactsCreated: number;
    contactsLinked: number;
    workerOfLinksCreated: number;
    skipped: number;
    errors: number;
  };
  createdOrgIds: number[];
  createdContactIds: number[];
  perRow: Array<{
    rowNum: number;
    status: 'created' | 'linked' | 'skipped' | 'error';
    orgBpId: number | null;
    contactBpId: number | null;
    message?: string;
  }>;
}

@Injectable()
export class BpImportService {
  private readonly logger = new Logger(BpImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: ExcelParserService,
    private readonly bpService: BusinessPartnersService,
  ) {}

  // ─── Step 1 — parse + auto-map ───────────────────────────────────────

  /**
   * Parse the xlsx and return headers + rows + a best-guess column
   * mapping. The wizard shows this as the initial state of step 2
   * (column mapping); the user can override.
   */
  async parse(buffer: Buffer): Promise<{
    headers: string[];
    rows: BpImportRow[];
    suggestedMapping: BpImportMapping;
    fileHash: string;
  }> {
    const parsed = await this.parser.parse(buffer);
    const rows: BpImportRow[] = parsed.rows.map((r, i) => ({
      rowNum: i + 2, // sheet row (1 was header)
      raw: r,
    }));
    return {
      headers: parsed.headers,
      rows,
      suggestedMapping: suggestMapping(parsed.headers),
      fileHash: parsed.fileHash,
    };
  }

  // ─── Step 3 — preview / dedup ────────────────────────────────────────

  async preview(input: {
    headers: string[];
    rows: BpImportRow[];
    mapping: BpImportMapping;
  }): Promise<BpImportPreview> {
    const { rows, mapping, headers } = input;
    const resolutions: BpImportRowResolution[] = [];
    for (const r of rows) {
      resolutions.push(await this.resolveRow(r, mapping));
    }

    const summary = {
      totalRows: resolutions.length,
      orgsToCreate: resolutions.filter((r) => r.org.action === 'create').length,
      orgsToLink: resolutions.filter((r) => r.org.action === 'link').length,
      orgConflicts: resolutions.filter((r) => r.org.action === 'conflict').length,
      contactsToCreate: resolutions.filter((r) => r.contact.action === 'create').length,
      contactsToLink: resolutions.filter((r) => r.contact.action === 'link').length,
      contactsSkipped: resolutions.filter((r) => r.contact.action === 'skip').length,
      errorRows: resolutions.filter((r) => r.errors.length > 0).length,
    };

    return {
      headers,
      mapping,
      suggestedMapping: suggestMapping(headers),
      rows,
      resolutions,
      summary,
    };
  }

  // ─── Step 4 — commit ─────────────────────────────────────────────────

  async commit(input: {
    headers: string[];
    rows: BpImportRow[];
    mapping: BpImportMapping;
    decisions?: BpImportDecision[];
    // The importer defaults to skipping errored rows. Set to true to
    // stop on the first hard error — useful for dry runs.
    stopOnError?: boolean;
  }): Promise<BpImportCommitResult> {
    const preview = await this.preview({ headers: input.headers, rows: input.rows, mapping: input.mapping });
    const decisionsByRow = new Map<number, BpImportDecision>();
    for (const d of input.decisions ?? []) decisionsByRow.set(d.rowNum, d);
    const emptyDecision: BpImportDecision = { rowNum: -1 };

    const result: BpImportCommitResult = {
      summary: {
        orgsCreated: 0, orgsLinked: 0,
        contactsCreated: 0, contactsLinked: 0,
        workerOfLinksCreated: 0,
        skipped: 0, errors: 0,
      },
      createdOrgIds: [],
      createdContactIds: [],
      perRow: [],
    };

    const workerOf = await this.prisma.partnerRelationshipType.findUnique({
      where: { code: 'worker_of' },
    });

    for (const res of preview.resolutions) {
      const dec = decisionsByRow.get(res.rowNum) ?? emptyDecision;
      const orgAction: 'link' | 'create' | 'skip' = dec.orgAction
        ?? (res.org.action === 'conflict' ? 'skip' : res.org.action);
      const contactAction = dec.contactAction ?? res.contact.action;

      // Blocking errors from resolveRow (e.g. no company + no contact) → skip.
      if (res.errors.length > 0) {
        result.summary.errors++;
        result.perRow.push({
          rowNum: res.rowNum, status: 'error',
          orgBpId: null, contactBpId: null,
          message: res.errors.join('; '),
        });
        if (input.stopOnError) break;
        continue;
      }

      try {
        // ─── ORG side ──────────────────────────────────────────────
        let orgBpId: number | null = null;
        if (orgAction === 'link') {
          orgBpId = dec.orgBpId ?? res.org.matchedBpId ?? null;
          if (!orgBpId) throw new Error('link action needs a target org BP id');
          result.summary.orgsLinked++;
        } else if (orgAction === 'create') {
          const created = await this.prisma.businessPartner.create({
            data: {
              partnerType: 'organization',
              displayName: res.values.company ?? '(unnamed)',
              companyName: res.values.company ?? null,
              email: res.values.email ?? null,
              phone: res.values.phone ?? null,
              website: res.values.website ?? null,
              address: res.values.address ?? null,
              notes: res.values.notes ?? null,
              source: 'import',
            },
          });
          orgBpId = created.id;
          result.createdOrgIds.push(created.id);
          result.summary.orgsCreated++;

          // If a real company domain was extracted from the email, own it.
          if (res.values.domain && !res.values.isPersonalDomain) {
            await this.prisma.businessPartnerDomain.create({
              data: { partnerId: created.id, domain: res.values.domain },
            }).catch(() => undefined); // If it collides (someone else grabbed it) — ignore, org is created.
          }
        } // else 'skip' → orgBpId stays null

        // ─── CONTACT side ──────────────────────────────────────────
        let contactBpId: number | null = null;
        if (contactAction === 'link') {
          contactBpId = dec.contactBpId ?? res.contact.matchedBpId ?? null;
          if (!contactBpId) throw new Error('link contact action needs a target person BP id');
          result.summary.contactsLinked++;
        } else if (contactAction === 'create') {
          const contactName = res.values.contactName ?? '';
          const [firstName, ...restName] = contactName.trim().split(/\s+/);
          const lastName = restName.join(' ') || null;
          const person = await this.prisma.businessPartner.create({
            data: {
              partnerType: 'person',
              displayName: contactName || res.values.email || '(unnamed)',
              firstName: firstName || null,
              lastName,
              email: res.values.email ?? null,
              phone: res.values.phone ?? null,
              mobile: res.values.mobile ?? null,
              notes: res.values.notes ?? null,
              source: 'import',
            },
          });
          contactBpId = person.id;
          result.createdContactIds.push(person.id);
          result.summary.contactsCreated++;
        }

        // ─── worker_of link ────────────────────────────────────────
        // If both sides materialized, wire the person → org edge so
        // the person shows up under the org on future queries.
        if (workerOf && orgBpId && contactBpId) {
          try {
            await this.prisma.partnerRelationship.create({
              data: {
                partyAId: contactBpId,
                partyBId: orgBpId,
                typeId: workerOf.id,
                isPrimary: true,
                titleAtB: res.values.roleOrDiscipline ?? null,
              },
            });
            result.summary.workerOfLinksCreated++;
          } catch {
            // Duplicate (P2002) means the link already exists — that's fine.
          }
        }

        if (orgAction === 'skip' && contactAction === 'skip') {
          result.summary.skipped++;
          result.perRow.push({ rowNum: res.rowNum, status: 'skipped', orgBpId, contactBpId });
        } else {
          const anyCreated = orgAction === 'create' || contactAction === 'create';
          result.perRow.push({
            rowNum: res.rowNum,
            status: anyCreated ? 'created' : 'linked',
            orgBpId,
            contactBpId,
          });
        }
      } catch (err: unknown) {
        result.summary.errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`bp-import row ${res.rowNum} failed: ${message}`);
        result.perRow.push({
          rowNum: res.rowNum, status: 'error',
          orgBpId: null, contactBpId: null,
          message,
        });
        if (input.stopOnError) break;
      }
    }

    return result;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async resolveRow(row: BpImportRow, mapping: BpImportMapping): Promise<BpImportRowResolution> {
    const values = extractValues(row.raw, mapping);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!values.company && !values.contactName && !values.email) {
      errors.push('row has no company, no contact name, and no email');
    }

    // ─── ORG resolution ───────────────────────────────────────────
    let orgAction: BpImportRowResolution['org']['action'];
    let orgReason = '';
    let matchedBpId: number | undefined;
    let matchedBpName: string | undefined;
    let matchReason: 'domain' | 'name' | undefined;

    if (!values.company && !values.email) {
      orgAction = 'skip';
      orgReason = 'no company name or email — nothing to bind an org from';
    } else {
      const match = await this.bpService.resolveOrgByDomainOrName({
        email: values.email ?? undefined,
        companyName: values.company ?? undefined,
      });
      if (match) {
        // Resolve display name for the preview.
        const bp = await this.prisma.businessPartner.findUnique({
          where: { id: match.id }, select: { displayName: true },
        });
        orgAction = 'link';
        matchedBpId = match.id;
        matchedBpName = bp?.displayName;
        matchReason = match.reason;
        orgReason = `matched existing BP by ${match.reason}`;
      } else if (values.email && values.isPersonalDomain && !values.company) {
        // Personal-domain email + no company name = we can't safely bind an org.
        orgAction = 'conflict';
        orgReason = `personal email domain "${values.domain}" and no company name — user must decide`;
      } else if (!values.company) {
        // Personal domain with real name doesn't create an org either.
        orgAction = 'skip';
        orgReason = `no company name; email domain "${values.domain}" is personal — cannot bind an org`;
      } else {
        orgAction = 'create';
        orgReason = 'no existing match by domain or name — new org';
      }
    }

    // ─── CONTACT resolution ───────────────────────────────────────
    let contactAction: BpImportRowResolution['contact']['action'];
    let contactReason = '';
    let contactMatchedBpId: number | undefined;
    let contactMatchedBpName: string | undefined;

    if (!values.contactName && !values.email) {
      contactAction = 'skip';
      contactReason = 'no contact name or email';
    } else if (values.email) {
      // Try to match a person by email (personal or work).
      const existing = await this.prisma.businessPartner.findFirst({
        where: { partnerType: 'person', email: values.email, deletedAt: null },
      });
      if (existing) {
        contactAction = 'link';
        contactMatchedBpId = existing.id;
        contactMatchedBpName = existing.displayName;
        contactReason = 'matched existing person by email';
      } else {
        contactAction = 'create';
        contactReason = 'new person';
      }
    } else {
      // No email but has a name — safest is to create; UI can override.
      contactAction = 'create';
      contactReason = 'new person (no email — email de-dup skipped)';
      warnings.push('contact has no email — de-dup by name alone is unreliable');
    }

    return {
      rowNum: row.rowNum,
      values,
      org: {
        action: orgAction,
        reason: orgReason,
        matchedBpId,
        matchedBpName,
        matchReason,
      },
      contact: {
        action: contactAction,
        reason: contactReason,
        matchedBpId: contactMatchedBpId,
        matchedBpName: contactMatchedBpName,
      },
      errors,
      warnings,
    };
  }
}

/** Extract normalised field values from a raw row via the mapping. */
function extractValues(raw: Record<string, string>, mapping: BpImportMapping) {
  const get = (f: BpImportField): string | null => {
    const col = mapping[f];
    if (!col) return null;
    const v = raw[col]?.trim();
    return v ? v : null;
  };

  const company = get('company');
  const contactFirstName = get('contactFirstName');
  const contactLastName = get('contactLastName');
  const nameFromParts = [contactFirstName, contactLastName].filter(Boolean).join(' ');
  const contactName = get('contactName') ?? (nameFromParts || null);
  const email = get('email')?.toLowerCase() ?? null;
  const domain = email ? extractEmailDomain(email) : null;
  const isPersonalDomain = domain
    ? PERSONAL_EMAIL_DOMAIN_FALLBACK.has(domain.toLowerCase())
    : false;

  return {
    company,
    contactName,
    email,
    domain,
    // Note: db personal-domain catalog check is done lazily in resolveOrgByDomainOrName;
    // the hard-coded fallback set here is enough for the preview split.
    isPersonalDomain,
    phone: get('phone'),
    mobile: get('mobile'),
    address: get('address'),
    roleOrDiscipline: get('roleOrDiscipline'),
    website: get('website'),
    notes: get('notes'),
  };
}

/**
 * Suggest a column mapping from a header list. Case-insensitive
 * substring match against a small synonym table. Never guarantees a
 * result for every field — the wizard's mapping step is the last word.
 */
function suggestMapping(headers: string[]): BpImportMapping {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, '');
  const table: Array<{ field: BpImportField; needles: string[] }> = [
    { field: 'company',            needles: ['company', 'org', 'firm', 'businessname'] },
    { field: 'contactName',        needles: ['contact', 'contactperson', 'contactname', 'fullname', 'name'] },
    { field: 'contactFirstName',   needles: ['firstname', 'givenname'] },
    { field: 'contactLastName',    needles: ['lastname', 'familyname', 'surname'] },
    { field: 'email',              needles: ['email', 'mail'] },
    { field: 'phone',              needles: ['phone', 'telephone', 'tel'] },
    { field: 'mobile',             needles: ['mobile', 'cell'] },
    { field: 'address',            needles: ['address', 'street'] },
    { field: 'roleOrDiscipline',   needles: ['role', 'discipline', 'title', 'position', 'profession'] },
    { field: 'website',            needles: ['website', 'url', 'site'] },
    { field: 'notes',              needles: ['note', 'comment'] },
  ];

  const out: BpImportMapping = {};
  const usedCols = new Set<string>();
  for (const { field, needles } of table) {
    const hit = headers.find((h) => {
      if (usedCols.has(h)) return false;
      const n = norm(h);
      return needles.some((needle) => n === needle || n.includes(needle));
    });
    if (hit) {
      out[field] = hit;
      usedCols.add(hit);
    }
  }
  return out;
}

/** Guard used by the controller to validate a client-supplied mapping. */
export function validateBpImportMapping(m: unknown): BpImportMapping {
  if (!m || typeof m !== 'object') {
    throw new BadRequestException('mapping must be an object');
  }
  const out: BpImportMapping = {};
  for (const [key, value] of Object.entries(m as Record<string, unknown>)) {
    if (!BP_IMPORT_FIELDS.includes(key as BpImportField)) {
      throw new BadRequestException(
        `Unknown mapping field "${key}". Allowed: ${BP_IMPORT_FIELDS.join(', ')}`,
      );
    }
    if (value != null && typeof value !== 'string') {
      throw new BadRequestException(`mapping.${key} must be a string header name (or omitted)`);
    }
    if (typeof value === 'string' && value.trim()) {
      out[key as BpImportField] = value.trim();
    }
  }
  return out;
}
