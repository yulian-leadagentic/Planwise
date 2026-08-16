import { Injectable } from '@nestjs/common';

import { ContactField } from './header-dictionary';

/**
 * BM2 · Contacts import wizard · Stage 4 — Split & merge.
 *
 * §6 of `docs/bm2/bp-import-methodology.md` — the two structural rules
 * that recover ~2,500 rows in the real dataset:
 *
 *  A · SPLIT (only for typed fields we can validate against a grammar):
 *      • email    — split on whitespace / , / ; / newline, but ONLY if
 *                   every piece independently matches the email regex.
 *                   One piece fails → NO SPLIT; the whole cell goes to
 *                   the conflict lane. (408 cells in the real folder.)
 *      • phone    — split on the same delimiters, again only when every
 *                   piece matches a phone pattern. Classify 05x → mobile,
 *                   area-code → landline.
 *      • name / company / free text — NEVER split (no validator, so no
 *                                     safe split).
 *
 *  B · MERGE / FORWARD-FILL (only by position, only on grouping columns):
 *      • company + discipline — a blank cell whose column was filled in
 *                               a row above, WHERE the current row still
 *                               carries contact data (email/phone/name),
 *                               inherits from above. (2,079 rows in real.)
 *      • Stop-fill on a new non-blank value; never fill across a blank
 *        separator row that has no contact data (that's the section
 *        break).
 *
 * Every synthesized cell (split-from-parent, filled-from-above) is
 * tracked in the result so Stage 5 can visually mark it (§9: "100% of
 * split & forward-fill actions are visible in preview before commit").
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Grammar-validated email. Same shape used by Stage 2's headerless fallback. */
const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i;

/**
 * Israeli phone shapes: mobile 05x-xxxxxxx, landline 0x-xxxxxxx / 04-xxx,
 * international +972-... . We accept optional dashes / spaces / parens.
 * Any candidate token that trims to at least 7 digits after stripping
 * separators is treated as a phone; the classifier below decides mobile
 * vs landline.
 */
const PHONE_STRIP = /[\s().-]/g;
const PHONE_DIGITS_MIN = 7;

/**
 * A single normalized row: one canonical field per key. Fields NOT
 * mapped are absent. Split-produced fields are always present; the
 * `synthesis` field on the wrapper says which values were derived.
 */
export type ResolvedValues = Partial<Record<ContactField, string>>;

/**
 * Extra phone slots produced by phone splitting. `mobile` and `phone`
 * are canonical; if the sheet's phone column had "052-1234567 03-9998888"
 * we split into mobile:052... + phone:03... — that's the common case.
 * Anything beyond the two canonical slots stays in a mixed `extraPhones`
 * array and Stage 5 shows it as an override chip.
 */
export interface ResolvedRow {
  /** 1-based row index in the source sheet (after header). */
  sourceRowIndex: number;
  values: ResolvedValues;
  /** Raw source cells keyed by header, preserved for the preview. */
  raw: Record<string, string>;
  /**
   * Everything we synthesized on this row — Stage 5 renders each as a
   * visible marker. Every entry MUST land here whenever we altered the
   * cell relative to the raw source (§9 target).
   */
  synthesis: RowSynthesis;
  /** Phones we split off but couldn't classify to mobile/phone slots. */
  extraPhones?: string[];
  /** Extra emails when the source cell held more than one address. */
  extraEmails?: string[];
  /** Best-effort human-readable errors for this row (never a stack trace). */
  errors: string[];
}

export interface RowSynthesis {
  /** True when we split multiple emails out of one source cell. */
  emailSplit?: boolean;
  /** True when we split multiple phones out of one source cell. */
  phoneSplit?: boolean;
  /** True when we filled the company from an earlier row. */
  companyFilled?: boolean;
  /** True when we filled the discipline from an earlier row. */
  disciplineFilled?: boolean;
  /** Row-level flag: this row failed the split validator; goes to conflict. */
  emailSplitFailed?: boolean;
  phoneSplitFailed?: boolean;
}

/**
 * Column mapping the wizard passes in — canonical field → source
 * header text (Stage 3's shape). Header text is used to look up the
 * cell in `raw`, so it must exactly match the sheet's header.
 */
export type ColumnMapping = Partial<Record<ContactField, string>>;

@Injectable()
export class ContactsSplitMergeService {
  /**
   * Resolve every data row of a sheet: extract typed values per the
   * mapping, apply split rules, then walk the rows top-down to apply
   * forward-fill on grouping fields.
   *
   * @param dataRows rows AFTER the header row — one Record<header, string>
   *                 per row. This matches the Stage 5 preview shape.
   * @param mapping  canonical field → source header (from Stage 3).
   */
  resolve(dataRows: ReadonlyArray<Record<string, string>>, mapping: ColumnMapping): ResolvedRow[] {
    // ── Phase A: extract + split per row ────────────────────────────
    const out: ResolvedRow[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i] ?? {};
      out.push(this.resolveRow(raw, mapping, i + 1));
    }

    // ── Phase B: forward-fill company + discipline top-down ─────────
    forwardFillColumn(out, 'company');
    forwardFillColumn(out, 'discipline');

    return out;
  }

  private resolveRow(
    raw: Record<string, string>,
    mapping: ColumnMapping,
    sourceRowIndex: number,
  ): ResolvedRow {
    const values: ResolvedValues = {};
    const errors: string[] = [];
    const synthesis: RowSynthesis = {};
    let extraEmails: string[] | undefined;
    let extraPhones: string[] | undefined;

    // Copy simple text fields straight through (trim only — never split).
    for (const field of ['contact', 'company', 'discipline', 'role', 'address', 'note'] as const) {
      const header = mapping[field];
      if (!header) continue;
      const v = (raw[header] ?? '').trim();
      if (v) values[field] = v;
    }

    // ── EMAIL split ─────────────────────────────────────────────────
    const emailHeader = mapping.email;
    if (emailHeader) {
      const cell = (raw[emailHeader] ?? '').trim();
      if (cell) {
        const parts = splitEmailCell(cell);
        if (parts.status === 'single') {
          values.email = parts.emails[0];
        } else if (parts.status === 'split') {
          values.email = parts.emails[0];
          extraEmails = parts.emails.slice(1);
          synthesis.emailSplit = true;
        } else {
          // The cell had a delimiter but at least one piece did not
          // validate — send to conflict lane. Preserve the original
          // text so the user can decide.
          values.email = cell;
          synthesis.emailSplitFailed = true;
          errors.push(
            `email cell "${truncate(cell)}" contains a delimiter but one or more pieces are not valid email addresses`,
          );
        }
      }
    }

    // ── PHONE split ─────────────────────────────────────────────────
    // We handle two source columns: `mobile` and `phone`. Each is
    // independently split. If a single-source cell contains a mixed
    // set (05x + landline), we route to the right slot per pattern.
    const mobileHeader = mapping.mobile;
    const phoneHeader = mapping.phone;

    const collected: { mobile: string[]; phone: string[]; extra: string[]; anyFailed: boolean; anySplit: boolean } = {
      mobile: [], phone: [], extra: [], anyFailed: false, anySplit: false,
    };

    if (mobileHeader) processPhoneCell((raw[mobileHeader] ?? '').trim(), 'mobile', collected);
    if (phoneHeader) processPhoneCell((raw[phoneHeader] ?? '').trim(), 'phone', collected);

    if (collected.mobile.length) values.mobile = collected.mobile[0];
    if (collected.phone.length) values.phone = collected.phone[0];
    const spillover = [...collected.mobile.slice(1), ...collected.phone.slice(1), ...collected.extra];
    if (spillover.length) extraPhones = spillover;
    if (collected.anySplit) synthesis.phoneSplit = true;
    if (collected.anyFailed) {
      synthesis.phoneSplitFailed = true;
      errors.push('phone cell contains a delimiter but at least one piece is not a valid phone number');
    }

    return {
      sourceRowIndex,
      values,
      raw,
      synthesis,
      extraEmails,
      extraPhones,
      errors,
    };
  }
}

// ─── Split helpers ─────────────────────────────────────────────────────

/**
 * Split an email cell on whitespace / , / ; / newline. Returns:
 *   'single' — one email, use as-is.
 *   'split'  — multiple emails, ALL validate. Use `emails` (order preserved).
 *   'fail'   — cell has a delimiter but at least one piece failed the
 *              validator. Caller preserves the original cell + surfaces
 *              a conflict-lane message.
 */
export function splitEmailCell(cell: string): {
  status: 'single' | 'split' | 'fail';
  emails: string[];
} {
  const trimmed = cell.trim();
  if (!trimmed) return { status: 'single', emails: [] };
  const parts = trimmed
    .split(/[\s,;\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    // Single value — validate softly, but let it through even if it
    // fails the regex (Stage 6 will surface a validation error).
    return { status: 'single', emails: [trimmed] };
  }
  const allValid = parts.every((p) => EMAIL_RE.test(p));
  if (!allValid) return { status: 'fail', emails: parts };
  return { status: 'split', emails: parts };
}

/**
 * Split a phone cell + classify each piece as mobile / landline. Israeli
 * pattern: mobile starts 05[0-9]; anything else with ≥ 7 digits is a
 * landline. International +972 is normalized to leading 0.
 */
export function splitPhoneCell(cell: string): {
  status: 'single' | 'split' | 'fail';
  mobiles: string[];
  phones: string[];
} {
  const trimmed = cell.trim();
  if (!trimmed) return { status: 'single', mobiles: [], phones: [] };
  const parts = trimmed
    .split(/[\s,;\n\r]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const classify = (p: string): 'mobile' | 'phone' | 'invalid' => {
    const stripped = p.replace(PHONE_STRIP, '');
    const noPlus = stripped.startsWith('+') ? stripped.slice(1) : stripped;
    // must be all digits after stripping
    if (!/^\d+$/.test(noPlus)) return 'invalid';
    if (noPlus.length < PHONE_DIGITS_MIN) return 'invalid';
    // Israel: +972 → 0, else assume leading 0 or country code
    let localized = noPlus;
    if (localized.startsWith('972')) localized = '0' + localized.slice(3);
    if (localized.startsWith('05')) return 'mobile';
    return 'phone';
  };

  if (parts.length <= 1) {
    const cls = classify(trimmed);
    if (cls === 'invalid') return { status: 'single', mobiles: [], phones: [trimmed] };
    if (cls === 'mobile') return { status: 'single', mobiles: [trimmed], phones: [] };
    return { status: 'single', mobiles: [], phones: [trimmed] };
  }
  const mobiles: string[] = [];
  const phones: string[] = [];
  let anyInvalid = false;
  for (const p of parts) {
    const cls = classify(p);
    if (cls === 'invalid') { anyInvalid = true; continue; }
    if (cls === 'mobile') mobiles.push(p);
    else phones.push(p);
  }
  if (anyInvalid) return { status: 'fail', mobiles, phones };
  return { status: 'split', mobiles, phones };
}

/**
 * Process one raw source phone cell — either the mobile-column cell or
 * the phone-column cell — routing pieces to the collected mobile/phone
 * slots. `sourceSlot` is a preference: if the classifier can't decide,
 * pieces stay in the source slot (a mobile-column entry stays mobile
 * even if the format isn't 05x). This keeps user intent visible when
 * the classifier disagrees.
 */
function processPhoneCell(
  cell: string,
  sourceSlot: 'mobile' | 'phone',
  acc: { mobile: string[]; phone: string[]; extra: string[]; anyFailed: boolean; anySplit: boolean },
) {
  if (!cell) return;
  const res = splitPhoneCell(cell);
  if (res.status === 'fail') {
    acc.anyFailed = true;
    // Even on fail, keep the pieces we could classify.
    acc.mobile.push(...res.mobiles);
    acc.phone.push(...res.phones);
    return;
  }
  if (res.status === 'split') acc.anySplit = true;

  if (res.mobiles.length === 0 && res.phones.length === 0) {
    // Single unclassifiable piece → stash into the source slot.
    if (sourceSlot === 'mobile') acc.mobile.push(cell);
    else acc.phone.push(cell);
    return;
  }
  acc.mobile.push(...res.mobiles);
  acc.phone.push(...res.phones);
}

// ─── Forward-fill helper ───────────────────────────────────────────────

/**
 * Walk the rows top-down and inherit `field`'s value from the nearest
 * filled row above when:
 *   • current row's field is blank, AND
 *   • the current row still carries contact data (email OR phone OR
 *     mobile OR contact-name — i.e. it's a "person of this org" row,
 *     not a blank separator)
 * When the current row is a blank separator (no contact data), it acts
 * as a section break and clears the inherited value.
 *
 * §6 in the methodology names this "MERGE / FORWARD-FILL — only by
 * position, only on grouping columns."
 */
function forwardFillColumn(rows: ResolvedRow[], field: 'company' | 'discipline'): void {
  let carry: string | null = null;
  const markKey: keyof RowSynthesis = field === 'company' ? 'companyFilled' : 'disciplineFilled';
  for (const row of rows) {
    const hasContact =
      !!row.values.email || !!row.values.phone || !!row.values.mobile || !!row.values.contact;
    const current = row.values[field];
    if (current) {
      // New value — refresh the carry, no inheritance needed.
      carry = current;
      continue;
    }
    if (!hasContact) {
      // Blank separator row — reset the carry, DO NOT inherit here.
      carry = null;
      continue;
    }
    if (carry) {
      row.values[field] = carry;
      row.synthesis[markKey] = true;
    }
  }
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
