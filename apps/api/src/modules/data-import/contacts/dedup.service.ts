import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  BusinessPartnersService,
  extractEmailDomain,
  PERSONAL_EMAIL_DOMAIN_FALLBACK,
} from '../../business-partners/business-partners.service';
import { ResolvedRow } from './split-merge.service';

/**
 * BM2 · Contacts import wizard · Stage 5 (preview) + Stage 6 (commit)
 * shared support — per-row dedup + org resolution.
 *
 * Follows the §3-Stage-6 dedup order verbatim:
 *   1. DOMAIN-FIRST — extract email domain; if it's a personal domain
 *      (PersonalEmailDomain catalog + hard-coded fallback set),
 *      NEVER bind an org. Route to conflict lane at Stage 5.
 *   2. COMPANY-NAME — normalized (lower / punctuation-stripped /
 *      whitespace-collapsed).
 *
 * Delegates the actual lookups to `BusinessPartnersService`
 * (`resolveOrgByDomainOrName` + `isPersonalDomainDb`) so the wizard
 * and the pre-existing BP flows stay in lockstep — if the personal-
 * domain catalog gets edited by the admin, the wizard reacts on the
 * next request without a code change.
 */
@Injectable()
export class ContactsDedupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bpService: BusinessPartnersService,
  ) {}

  /**
   * Grade every resolved row for what will happen at commit time.
   * `orgAction`  = link | create | skip | conflict
   * `contactAction` = link | create | skip
   * No writes here — this powers Stage 5's preview.
   */
  async decide(rows: ResolvedRow[]): Promise<DedupDecision[]> {
    const out: DedupDecision[] = [];
    for (const row of rows) {
      out.push(await this.decideRow(row));
    }
    return out;
  }

  private async decideRow(row: ResolvedRow): Promise<DedupDecision> {
    const values = row.values;
    const email = values.email?.toLowerCase();
    const domain = extractEmailDomain(email);
    const isPersonalDomain = !!domain && (await this.isPersonalDomain(domain));

    // ─── Minimum contract (§7) — name AND (email OR phone) ─────────
    // A row that fails the floor gets a skip decision + a clear reason.
    // The commit step honours the same rule so re-running the same file
    // stays idempotent.
    const hasName = !!values.contact;
    const hasReach = !!(values.email || values.phone || values.mobile);
    const meetsContract = hasName && hasReach;
    const contractError = meetsContract
      ? null
      : buildContractError(hasName, hasReach);

    // ─── Org resolution ────────────────────────────────────────────
    let org: DedupSide;
    if (!values.company && !email) {
      org = {
        action: 'skip',
        reason: 'no company name or email — nothing to bind an org from',
      };
    } else {
      const match = await this.bpService.resolveOrgByDomainOrName({
        email: email ?? undefined,
        companyName: values.company ?? undefined,
      });
      if (match) {
        const bp = await this.prisma.businessPartner.findUnique({
          where: { id: match.id },
          select: { id: true, displayName: true, companyName: true },
        });
        org = {
          action: 'link',
          matchedBpId: match.id,
          matchedBpName: bp?.displayName ?? bp?.companyName ?? null,
          matchReason: match.reason,
          reason: `matched existing BP by ${match.reason}`,
        };
      } else if (email && isPersonalDomain && !values.company) {
        // §3 dedup rule 2: personal email + no company text → conflict.
        // Domain never defines a company; without a company name we
        // have no safe way to bind an org.
        org = {
          action: 'conflict',
          reason: `personal email domain "${domain}" and no company name — needs a decision`,
        };
      } else if (!values.company) {
        org = {
          action: 'skip',
          reason: `no company name; email domain "${domain ?? ''}" is personal — cannot bind an org`,
        };
      } else {
        org = {
          action: 'create',
          reason: 'no existing match by domain or name — new org',
        };
      }
    }

    // ─── Person resolution ─────────────────────────────────────────
    let contact: DedupSide;
    if (!values.contact && !email) {
      contact = { action: 'skip', reason: 'no contact name or email' };
    } else if (email) {
      const existing = await this.prisma.businessPartner.findFirst({
        where: { partnerType: 'person', email, deletedAt: null },
        select: { id: true, displayName: true },
      });
      if (existing) {
        contact = {
          action: 'link',
          matchedBpId: existing.id,
          matchedBpName: existing.displayName,
          reason: 'matched existing person by email',
        };
      } else {
        contact = { action: 'create', reason: 'new person' };
      }
    } else {
      contact = { action: 'create', reason: 'new person (no email — dedup by name only)' };
    }

    return {
      sourceRowIndex: row.sourceRowIndex,
      values,
      domain: domain ?? null,
      isPersonalDomain,
      meetsMinimumContract: meetsContract,
      contractError,
      org,
      contact,
    };
  }

  /** Combined check — hard-coded fallback OR admin-managed catalog. */
  private async isPersonalDomain(domain: string): Promise<boolean> {
    const lower = domain.toLowerCase();
    if (PERSONAL_EMAIL_DOMAIN_FALLBACK.has(lower)) return true;
    const row = await this.prisma.personalEmailDomain.findUnique({ where: { domain: lower } });
    return !!row;
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

export type OrgAction = 'link' | 'create' | 'skip' | 'conflict';
export type ContactAction = 'link' | 'create' | 'skip';

export interface DedupSide {
  action: OrgAction | ContactAction;
  reason: string;
  matchedBpId?: number;
  matchedBpName?: string | null;
  matchReason?: 'domain' | 'name';
}

export interface DedupDecision {
  sourceRowIndex: number;
  values: Record<string, string | undefined>;
  domain: string | null;
  isPersonalDomain: boolean;
  meetsMinimumContract: boolean;
  contractError: string | null;
  org: DedupSide;
  contact: DedupSide;
}

function buildContractError(hasName: boolean, hasReach: boolean): string {
  const missing: string[] = [];
  if (!hasName) missing.push('name');
  if (!hasReach) missing.push('email or phone');
  return `row missing ${missing.join(' + ')} — the minimum contract is "name AND (email OR phone)"`;
}
