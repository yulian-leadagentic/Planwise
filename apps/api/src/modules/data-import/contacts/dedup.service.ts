import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  BusinessPartnersService,
  extractEmailDomain,
  PERSONAL_EMAIL_DOMAIN_FALLBACK,
} from '../../business-partners/business-partners.service';
import { ResolvedRow, SecondaryContact } from './split-merge.service';

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
   *
   * QA4 R2b ORG-1 (2026-09-29) — intra-batch org dedupe. A single file
   * regularly repeats the same firm across many rows (colleagues sharing
   * a company). The per-row lookup above resolves each row against the
   * DB in isolation, so two "new" rows that share a firm both come back
   * as `create` and the commit path creates the same org twice.
   *
   * Fix: after the per-row pass, walk the decisions and compute a
   * `batchOrgKey` per row (matched existing BP id · non-personal
   * email domain · normalized company name). Group rows by that key.
   * Per group: the FIRST occurrence stays as the "leader" (its
   * `orgAction` is unchanged); subsequent rows in the same group flip
   * from `create` → `link` and carry the batch key so the commit path
   * can materialise the org exactly once and share its id.
   *
   * `batchOrgKey` is also surfaced to the wizard so the ORG-2 review
   * panel can render "1 org · 4 people" instead of four separate rows.
   */
  async decide(rows: ResolvedRow[]): Promise<DedupDecision[]> {
    const out: DedupDecision[] = [];
    for (const row of rows) {
      out.push(await this.decideRow(row));
    }
    const deduped = this.applyIntraBatchOrgDedupe(out);
    // QA4 E5 (2026-09-29) — for every side that matched an existing
    // BP, fetch the current field values so the FE can compute per-
    // field diffs against the imported row and offer a keep/use
    // chooser. Batched by unique BP id so we make one query per
    // partnerType regardless of how many rows share a match.
    await this.attachExistingFields(deduped);
    return deduped;
  }

  /**
   * QA4 E5 (2026-09-29) — populate `existingFields` on every DedupSide
   * that matched an existing BP so the wizard can compute per-field
   * diffs. Values are the raw BP columns (contact/company/email/phone/
   * mobile/discipline/role/address/note); `null` for empty on the DB.
   * Runs 2 queries max (persons + orgs).
   */
  private async attachExistingFields(decisions: DedupDecision[]): Promise<void> {
    const orgIds = new Set<number>();
    const personIds = new Set<number>();
    for (const d of decisions) {
      if (d.org.matchedBpId != null) orgIds.add(d.org.matchedBpId);
      if (d.contact.matchedBpId != null) personIds.add(d.contact.matchedBpId);
    }
    const orgById = new Map<number, Record<string, string | null>>();
    if (orgIds.size > 0) {
      const rows = await this.prisma.businessPartner.findMany({
        where: { id: { in: [...orgIds] } },
        select: {
          id: true,
          displayName: true,
          companyName: true,
          email: true,
          phone: true,
          mobile: true,
          address: true,
          notes: true,
          // QA4 IW-9 (2026-09-30) — surface the matched org's current
          // PartnerRoleType so the wizard can display "keeps existing
          // type: <TYPE>" on link cards instead of a bare literal.
          // Null when the org has no main role assigned yet — the FE
          // then shows the Partner-default type picker (unset existing
          // orgs are typeable at import time; the commit path fills
          // the null without overwriting a set type).
          mainRoleType: { select: { name: true } },
        },
      });
      for (const r of rows) {
        orgById.set(r.id, {
          company: r.companyName ?? r.displayName ?? null,
          email: r.email ?? null,
          phone: r.phone ?? null,
          mobile: r.mobile ?? null,
          address: r.address ?? null,
          note: r.notes ?? null,
          mainRoleType: r.mainRoleType?.name ?? null,
        });
      }
    }
    const personById = new Map<number, Record<string, string | null>>();
    if (personIds.size > 0) {
      const rows = await this.prisma.businessPartner.findMany({
        where: { id: { in: [...personIds] } },
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          mobile: true,
          address: true,
          notes: true,
          discipline: { select: { name: true } },
        },
      });
      for (const r of rows) {
        personById.set(r.id, {
          contact: r.displayName ?? null,
          email: r.email ?? null,
          phone: r.phone ?? null,
          mobile: r.mobile ?? null,
          address: r.address ?? null,
          note: r.notes ?? null,
          discipline: r.discipline?.name ?? null,
        });
      }
    }
    for (const d of decisions) {
      if (d.org.matchedBpId != null) {
        const fields = orgById.get(d.org.matchedBpId);
        if (fields) d.org.existingFields = fields;
      }
      if (d.contact.matchedBpId != null) {
        const fields = personById.get(d.contact.matchedBpId);
        if (fields) d.contact.existingFields = fields;
      }
    }
  }

  /**
   * QA4 R2b ORG-1 — assign a `batchOrgKey` per decision and collapse
   * duplicate `create` intents across the batch. Deterministic:
   *   1. Existing BP match → `bp:<id>`
   *   2. Non-personal email domain → `domain:<lower-cased>`
   *   3. Normalized company name → `name:<lower-cased-collapsed>`
   *   4. Nothing → `null` (isolated row, no grouping possible)
   *
   * The first row per key keeps its native decision. Subsequent rows
   * with `orgAction === 'create'` become `orgAction === 'link'`
   * pointing at the future org (commit resolves the concrete BP id
   * from the batch key). Rows that already resolved to `link` /
   * `skip` / `conflict` stay as-is; the batch key still gets attached
   * so the preview grouping still works.
   */
  private applyIntraBatchOrgDedupe(decisions: DedupDecision[]): DedupDecision[] {
    const leaderByKey = new Map<string, DedupDecision>();
    for (const d of decisions) {
      const key = computeBatchOrgKey(d);
      d.batchOrgKey = key;
      if (!key) continue;

      const leader = leaderByKey.get(key);
      if (!leader) {
        leaderByKey.set(key, d);
        // Mark the leader when the group ends up with > 1 row (below).
        continue;
      }

      // Subsequent row shares the leader's key.
      // Preserve conflict / skip verdicts (they aren't org-create intents).
      if (d.org.action === 'create') {
        // Flip to link — the commit path will resolve the batch key
        // to the leader's freshly-created org id.
        d.org = {
          action: 'link',
          matchReason: leader.org.matchReason ?? undefined,
          matchedBpId: leader.org.matchedBpId, // may be null; commit resolves via batchOrgKey
          matchedBpName:
            leader.org.matchedBpName ??
            d.values.company ??
            leader.values.company ??
            null,
          reason:
            leader.org.action === 'create'
              ? 'batch-deduped — will link to org created earlier in this file'
              : `batch-deduped — same as row ${leader.sourceRowIndex} (${leader.org.reason})`,
        };
      } else if (d.org.action === 'link' && !d.org.matchedBpId && leader.org.matchedBpId) {
        // Rare case: the row itself wouldn't resolve via DB lookup, but
        // the batch leader already matched an existing BP. Attach the
        // matched id so the person still gets `worker_of` the right org.
        d.org = { ...d.org, matchedBpId: leader.org.matchedBpId };
      }
    }
    return decisions;
  }

  private async decideRow(row: ResolvedRow): Promise<DedupDecision> {
    const values = row.values;
    const email = values.email?.toLowerCase();
    const domain = extractEmailDomain(email);
    const isPersonalDomain = !!domain && (await this.isPersonalDomain(domain));
    // QA4 RD-3 (2026-09-29) — the raw company cell may hold a stray
    // email or a dash (real sheets do). Never let those flow into the
    // org identity: `plausibleCompanyName` is the value we key dedup
    // and commit off; the raw company text stays on the values map so
    // the preview still shows what the cell said.
    const plausibleCompanyName = values.company && isPlausibleCompanyName(values.company)
      ? values.company
      : undefined;

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
    if (!plausibleCompanyName && !email) {
      org = {
        action: 'skip',
        reason: 'no company name or email — nothing to bind an org from',
      };
    } else {
      const match = await this.bpService.resolveOrgByDomainOrName({
        email: email ?? undefined,
        companyName: plausibleCompanyName ?? undefined,
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
      } else if (email && isPersonalDomain && !plausibleCompanyName) {
        // §3 dedup rule 2: personal email + no company text → conflict.
        // Domain never defines a company; without a company name we
        // have no safe way to bind an org.
        org = {
          action: 'conflict',
          reason: `personal email domain "${domain}" and no company name — needs a decision`,
        };
      } else if (!plausibleCompanyName) {
        // QA4 RD-3 — no plausible company AND a non-personal domain →
        // we still key dedupe on the domain (colleagues collapse into
        // one org) via batchOrgKey. The leader's `values.company` will
        // be undefined; commit uses a domain-derived fallback name.
        org = {
          action: 'create',
          reason: domain
            ? `no company name — will group under domain "${domain}"`
            : 'no company name; no domain — cannot bind an org',
        };
        if (!domain) org.action = 'skip';
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
      // QA4 IMP-4 — pass secondary contacts through to the preview so
      // the Preview table can render each as its own row (tagged
      // "extracted"). Commit reads them off ResolvedRow directly.
      secondaryContacts: row.secondaryContacts,
      // QA4 R2 IMP-9 — additional emails picked out of a multi-email
      // cell. Commit classifies each into person primary / org primary /
      // additional-emails list per the routing spec.
      extraEmails: row.extraEmails,
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
  /**
   * QA4 E5 (2026-09-29) — the matched BP's current field values, so
   * the wizard can diff against the imported row and show a per-field
   * "keep existing / use imported" chooser. Populated only when
   * `matchedBpId` is set. `null` = empty on the DB.
   */
  existingFields?: Record<string, string | null>;
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
  /** QA4 IMP-4 — extracted office managers etc. (see split-merge). */
  secondaryContacts?: SecondaryContact[];
  /**
   * QA4 R2 IMP-9 — additional emails beyond the primary. Emitted when
   * the split-merge classifier saw more than one valid email on the
   * row (SPLIT status). Routed at commit time: personal → person's
   * additional list; generic (`office@`, `info@`, `studio@`, `mail@`)
   * → the org's additional list; whatever is left over as the person's
   * secondary personal email. See commit.service.
   */
  extraEmails?: string[];
  /**
   * QA4 R2b ORG-1 (2026-09-29) — intra-batch group key. Rows sharing
   * a key resolve/create the same org exactly once at commit time.
   * `null` when the row has nothing to group on (no matched BP, no
   * non-personal email domain, no company name).
   *
   * Encoding (kept stable so the FE grouping can key off it directly):
   *   `bp:<id>`         — matched an existing BusinessPartner
   *   `domain:<host>`   — non-personal email domain (lower-cased)
   *   `name:<slug>`     — normalized company name
   */
  batchOrgKey?: string | null;
}

function buildContractError(hasName: boolean, hasReach: boolean): string {
  const missing: string[] = [];
  if (!hasName) missing.push('name');
  if (!hasReach) missing.push('email or phone');
  return `row missing ${missing.join(' + ')} — the minimum contract is "name AND (email OR phone)"`;
}

/**
 * QA4 R2b ORG-1 — deterministic key that groups rows sharing an
 * organization. Ordering mirrors `resolveOrgByDomainOrName`: matched
 * BP wins, else the (non-personal) domain, else the normalized name.
 * Returns `null` when the row has no groupable signal.
 */
export function computeBatchOrgKey(d: DedupDecision): string | null {
  // 1. Existing BP already picked at Stage-5 dedup.
  if (d.org.matchedBpId != null) return `bp:${d.org.matchedBpId}`;
  // 2. Non-personal email domain — the strongest "same firm" signal
  //    when both rows carry a corporate address.
  // QA4 RD-3 (2026-09-29): only key on a domain that PASSES the shape
  // check. `extractEmailDomain` now sanitises trailing junk (`yad.co.il>`
  // from an Outlook copy-paste, whitespace, list delimiters) and returns
  // null on a mangled result — but a stale in-memory decision built
  // before the sanitiser could still carry a bad string, so we re-guard
  // here. A bad-shape domain falls through to name-based grouping.
  if (d.domain && !d.isPersonalDomain && isLikelyDomain(d.domain)) {
    return `domain:${d.domain.toLowerCase()}`;
  }
  // 3. Normalized company name — collapse case + whitespace so
  //    "A.B. Planners" and "a.b. planners  " land on the same key.
  //    Reject names that look like an email or a bare `-` / `—` /
  //    single-character (RD-3): those are never real org identities
  //    and would otherwise collapse unrelated rows into one group.
  const company = (d.values.company ?? '').trim();
  if (company && isPlausibleCompanyName(company)) return `name:${normalizeCompanyName(company)}`;
  return null;
}

/** Case-insensitive whitespace-collapsed name key. Kept minimal so
 * the FE and BE can compute the exact same slug for display. */
export function normalizeCompanyName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * QA4 RD-3 (2026-09-29) — a raw domain string is "domain-shaped" only
 * when it matches `<label>.<label>+` with no whitespace, brackets, or
 * `@`. Anything else came from a mangled cell and must NOT become a
 * batchOrgKey (otherwise `mra.co.il>` and `mra.co.il` group as two
 * separate orgs).
 */
const DOMAIN_SHAPE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
function isLikelyDomain(s: string): boolean {
  return DOMAIN_SHAPE_RE.test(s.trim());
}

/**
 * QA4 RD-3 (2026-09-29) — reject "company names" that are actually an
 * email, a dash, or a lone character. Sheets carry those when the row
 * only had contact info + email; we must never use them as an org
 * identity.
 */
export function isPlausibleCompanyName(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.length < 2) return false;
  if (s.includes('@')) return false; // an email is never an org name
  if (/^[-‐-―–—]+$/.test(s)) return false; // dash-only cells
  return true;
}
