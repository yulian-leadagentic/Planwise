import { Injectable } from '@nestjs/common';

import { ContactField } from './header-dictionary';
import { classifyCell } from './recognizers/classifier';
import { DEFAULT_SECONDARY_TITLE } from './recognizers/titles';

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
  /**
   * QA4 IMP-4 — secondary contacts assembled by the content classifier
   * (e.g. an office manager whose name sat in the phone cell). Each
   * secondary carries a `worker_of` back to the primary row's org and
   * inherits the row's discipline. Dedup within the same org by
   * (name, phone/email) happens in `dedupeSecondaryContactsByOrg`.
   */
  secondaryContacts?: SecondaryContact[];
}

/**
 * Extracted secondary contact — a person the classifier assembled
 * from tokens outside the primary contact-name cell (the office-
 * manager case, per QA4 IMP-4).
 */
export interface SecondaryContact {
  /** Assembled display name from the classifier. */
  name: string;
  /** Nearest phone token — usually the office landline. */
  phone?: string;
  /** Nearest mobile token, when the source cell carried one. */
  mobile?: string;
  /** Nearest email token, when the source cell carried one. */
  email?: string;
  /** Optional city extracted from the trailing ` - <city>` fragment. */
  city?: string;
  /** Default: `Office manager` unless the classifier hit a title. */
  title: string;
  /** Which mapped column the name was pulled from — for the preview. */
  sourceField: 'phone' | 'mobile' | 'email' | 'company' | 'note';
  /** 0..1; average of the underlying tokens' confidences. */
  confidence: number;
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
 *
 * QA4 R2 IMP-8 (2026-09-29) — a target field may accept an array of
 * source headers, and the classifier merges them by content-type at
 * parse time (e.g. two sheet columns feeding "Job Title", or a
 * phone-info column feeding both `phone` and `mobile`). A single
 * string still works for backward compatibility with all Stage 3
 * presets and every caller written before this change.
 */
export type ColumnMapping = Partial<Record<ContactField, string | string[]>>;

/**
 * Normalise a mapping value to an ordered list of source headers.
 * Empty / undefined values → empty list. String → single-element list.
 * Callers can iterate the returned list uniformly without checking
 * the shape at every site. Blank/duplicate headers are dropped.
 */
export function mappingHeaders(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const h = (raw ?? '').trim();
    if (!h) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

/**
 * Convenience — get the primary (first) mapped header for a field.
 * Preserves the pre-IMP-8 "one header per field" call sites that need
 * a scalar for display / preset serialisation.
 */
export function primaryMappingHeader(value: string | string[] | undefined): string | undefined {
  const list = mappingHeaders(value);
  return list[0];
}

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
   * @param excelRowIndexes optional 1-based Excel row numbers matching
   *   each element of `dataRows`. When present, `sourceRowIndex` on
   *   every ResolvedRow becomes the actual sheet row number the user
   *   sees when opening the file (QA4 IMP-3). When omitted, we fall
   *   back to 1..N (legacy behaviour) so any caller that hasn't opted
   *   in still gets stable indexes.
   */
  resolve(
    dataRows: ReadonlyArray<Record<string, string>>,
    mapping: ColumnMapping,
    excelRowIndexes?: ReadonlyArray<number>,
  ): ResolvedRow[] {
    // ── Phase A: extract + split per row ────────────────────────────
    const out: ResolvedRow[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const raw = dataRows[i] ?? {};
      const sourceRowIndex = excelRowIndexes?.[i] ?? i + 1;
      out.push(this.resolveRow(raw, mapping, sourceRowIndex));
    }

    // ── Phase B: forward-fill company + discipline top-down ─────────
    forwardFillColumn(out, 'company');
    forwardFillColumn(out, 'discipline');

    // ── Phase C: dedup secondary contacts within each org ──────────
    // A phone-cell name (office manager) that repeats across two rows
    // of the same company (same phone → same person) should collapse
    // to a single contact. QA4 IMP-4 DoD.
    dedupeSecondaryContactsByOrg(out);

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
    // QA4 R2 IMP-8 — every field may be fed by MULTIPLE source columns;
    // iterate and pick the first non-blank value for the text-only
    // fields. The classifier handles the phone/email fields separately
    // below (they're the interesting merge cases).
    for (const field of ['contact', 'company', 'discipline', 'role', 'address', 'note'] as const) {
      const headers = mappingHeaders(mapping[field]);
      if (headers.length === 0) continue;
      const collectedTextValues: string[] = [];
      for (const header of headers) {
        const v = (raw[header] ?? '').trim();
        if (v) collectedTextValues.push(v);
      }
      if (collectedTextValues.length === 0) continue;
      // For `role` and `discipline` we join with " · " so IMP-10 sees
      // both classifier hits. For the identity fields (contact/company)
      // keep the first non-blank — merging two identity strings would
      // corrupt the dedup key.
      if (field === 'role' || field === 'discipline' || field === 'note' || field === 'address') {
        // Dedup case-insensitively; the sheet may repeat the same
        // value across two mapped columns.
        const seen = new Set<string>();
        const uniq = collectedTextValues.filter((v) => {
          const key = v.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        values[field] = uniq.length > 1 ? uniq.join(' · ') : uniq[0];
      } else {
        values[field] = collectedTextValues[0];
      }
    }

    // ── EMAIL split ─────────────────────────────────────────────────
    // QA4 R2 IMP-8 — iterate every mapped email column and union
    // their split results. The first valid email lands on `values.email`;
    // subsequent ones flow into `extraEmails`. A failed split on any
    // one column still flags the row (surfaces to conflict lane).
    const emailHeaders = mappingHeaders(mapping.email);
    if (emailHeaders.length > 0) {
      const allEmails: string[] = [];
      let anyFailed = false;
      let anySplit = false;
      const failedCells: string[] = [];
      for (const emailHeader of emailHeaders) {
        const cell = (raw[emailHeader] ?? '').trim();
        if (!cell) continue;
        const parts = splitEmailCell(cell);
        if (parts.status === 'single') {
          if (parts.emails[0]) allEmails.push(parts.emails[0]);
        } else if (parts.status === 'split') {
          allEmails.push(...parts.emails);
          anySplit = true;
        } else {
          allEmails.push(cell);
          anyFailed = true;
          failedCells.push(cell);
        }
      }
      // Dedup email list case-insensitively.
      const seen = new Set<string>();
      const uniq = allEmails.filter((e) => {
        const key = e.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (uniq.length > 0) {
        values.email = uniq[0];
        if (uniq.length > 1) extraEmails = uniq.slice(1);
      }
      if (anySplit) synthesis.emailSplit = true;
      if (anyFailed) {
        synthesis.emailSplitFailed = true;
        for (const cell of failedCells) {
          errors.push(
            `email cell "${truncate(cell)}" contains a delimiter but one or more pieces are not valid email addresses`,
          );
        }
      }
    }

    // ── PHONE split + name-in-phone-cell extraction ─────────────────
    // QA4 IMP-4 — every phone-slot cell runs through the content
    // classifier (deterministic recognizer chain). This lets us keep
    // the existing "split into mobile/phone slots" behaviour AND pull
    // a secretary/office-manager name out of the same cell as a
    // secondary contact, without a per-file heuristic.
    // QA4 R2 IMP-8 — every mobile/phone-mapped column feeds the same
    // accumulator; the classifier decides which slot each token
    // belongs to by content, regardless of the source column.
    const mobileHeaders = mappingHeaders(mapping.mobile);
    const phoneHeaders = mappingHeaders(mapping.phone);

    const collected: { mobile: string[]; phone: string[]; extra: string[]; anyFailed: boolean; anySplit: boolean } = {
      mobile: [], phone: [], extra: [], anyFailed: false, anySplit: false,
    };
    const secondaries: SecondaryContact[] = [];

    for (const header of mobileHeaders) {
      processPhoneCellWithClassifier(
        (raw[header] ?? '').trim(),
        'mobile',
        collected,
        secondaries,
        (values.contact ?? '').trim(),
      );
    }
    for (const header of phoneHeaders) {
      processPhoneCellWithClassifier(
        (raw[header] ?? '').trim(),
        'phone',
        collected,
        secondaries,
        (values.contact ?? '').trim(),
      );
    }

    if (collected.mobile.length) values.mobile = collected.mobile[0];
    if (collected.phone.length) values.phone = collected.phone[0];
    const spillover = [...collected.mobile.slice(1), ...collected.phone.slice(1), ...collected.extra];
    if (spillover.length) extraPhones = spillover;
    if (collected.anySplit) synthesis.phoneSplit = true;
    // Only hard-flag `phoneSplitFailed` when the classifier failed to
    // extract anything useful (no phone AND no name). A cell that
    // carried a real name + phone is a successful extraction, not a
    // failure — QA4 IMP-4 DoD.
    if (collected.anyFailed && secondaries.length === 0) {
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
      secondaryContacts: secondaries.length > 0 ? secondaries : undefined,
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
 * QA4 IMP-4 — evolves `processPhoneCell` to route through the content
 * classifier. Still routes phone tokens to the mobile/phone slots per
 * grammar, and now also pulls out a name+city as a `SecondaryContact`
 * when the classifier surfaces one. `primaryContactName` is the row's
 * primary contact — used to skip echoes of the same person's name in
 * the phone cell (some sheets repeat the person's name next to their
 * mobile as a note).
 */
function processPhoneCellWithClassifier(
  cell: string,
  sourceSlot: 'mobile' | 'phone',
  acc: { mobile: string[]; phone: string[]; extra: string[]; anyFailed: boolean; anySplit: boolean },
  secondaries: SecondaryContact[],
  primaryContactName: string,
) {
  if (!cell) return;
  const classified = classifyCell(cell);

  // ── Phone routing ────────────────────────────────────────────────
  // Each phone match goes to its own slot per grammar (mobile vs
  // landline). If the classifier found no phones at all but the cell
  // was non-empty and looked like data, drop into the source slot
  // verbatim — matches the legacy "single unclassifiable piece →
  // source slot" behaviour.
  if (classified.phones.length === 0) {
    // Cell had text but no phone-shaped token — legacy fallback so
    // "1234" style entries still land in the slot (Stage 6 validates).
    if (!classified.name && !classified.title && !classified.city && cell.trim()) {
      if (sourceSlot === 'mobile') acc.mobile.push(cell);
      else acc.phone.push(cell);
    }
  } else {
    if (classified.phones.length > 1) acc.anySplit = true;
    for (const p of classified.phones) {
      if (p.kind === 'mobile') acc.mobile.push(p.raw);
      else acc.phone.push(p.raw);
    }
  }

  // Detect a genuine "split failed" — cell had multiple tokens that
  // weren't phone-shaped AND weren't classifiable as a name/title/city
  // (real junk, not extracted metadata).
  const unknowns = classified.tokens.filter((t) => t.type === 'unknown');
  if (unknowns.length > 0 && classified.phones.length > 0) {
    acc.anyFailed = true;
  }

  // ── Secondary contact assembly ───────────────────────────────────
  // Emit a secondary contact when the classifier surfaced a name that
  // isn't just a repeat of the primary contact and either (a) sits
  // alongside a phone number in the cell or (b) sits alongside a
  // title (rare — most sheets omit the title). `Office manager` is the
  // default title, per the DoD in `docs/bm2/qa4-import-preview.md`.
  const name = classified.name?.trim();
  if (name) {
    const isEchoOfPrimary = primaryContactName && normalizeForCompare(name) === normalizeForCompare(primaryContactName);
    if (!isEchoOfPrimary && (classified.phones.length > 0 || classified.title)) {
      const firstPhone = classified.phones[0];
      const kind = firstPhone?.kind;
      const secondary: SecondaryContact = {
        name,
        // Route the associated phone into the right slot on the
        // secondary contact too. If the source slot was `mobile` we
        // still let the grammar decide (a 03-x number from a mobile
        // column is landline).
        phone: firstPhone && kind !== 'mobile' ? firstPhone.raw : undefined,
        mobile: firstPhone && kind === 'mobile' ? firstPhone.raw : undefined,
        city: classified.city?.value,
        title: classified.title ?? DEFAULT_SECONDARY_TITLE,
        sourceField: sourceSlot,
        confidence: averageConfidence(classified),
      };
      secondaries.push(secondary);
    }
  }
}

function averageConfidence(c: ReturnType<typeof classifyCell>): number {
  const relevant = c.tokens.filter((t) => t.type !== 'unknown');
  if (relevant.length === 0) return 0;
  const sum = relevant.reduce((s, t) => s + t.confidence, 0);
  return Number((sum / relevant.length).toFixed(2));
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s‐-―.\-'"׳״]+/g, '').trim();
}

/**
 * Legacy wrapper kept for callers that used the plain-grammar path
 * before the classifier landed (QA4 IMP-4). Delegates to the new
 * processor with an empty secondaries sink and no primary-name echo
 * suppression — the return-shape stays the same as before.
 */
function processPhoneCell(
  cell: string,
  sourceSlot: 'mobile' | 'phone',
  acc: { mobile: string[]; phone: string[]; extra: string[]; anyFailed: boolean; anySplit: boolean },
) {
  processPhoneCellWithClassifier(cell, sourceSlot, acc, [], '');
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

/**
 * QA4 IMP-4 — dedup secondary contacts within each (post-fill) org.
 * Key = normalized (name, phone|mobile|email). When a secondary is
 * already claimed on an earlier row for the same org, we DROP it from
 * the later row so the preview shows only the first occurrence — the
 * PM sees "one office manager per firm", not "3 duplicates".
 *
 * Runs after forward-fill so `row.values.company` is the effective
 * company, not the raw source cell.
 */
function dedupeSecondaryContactsByOrg(rows: ResolvedRow[]): void {
  const seen: Map<string, Set<string>> = new Map(); // orgKey → set of contactKeys
  for (const row of rows) {
    if (!row.secondaryContacts || row.secondaryContacts.length === 0) continue;
    const orgKey = normalizeForCompare(row.values.company ?? '');
    if (!seen.has(orgKey)) seen.set(orgKey, new Set());
    const claimed = seen.get(orgKey)!;
    const survivors: SecondaryContact[] = [];
    for (const s of row.secondaryContacts) {
      const dedupKey = [
        normalizeForCompare(s.name),
        s.phone ? normalizeForCompare(s.phone) : '',
        s.mobile ? normalizeForCompare(s.mobile) : '',
        s.email ? normalizeForCompare(s.email) : '',
      ].join('|');
      if (claimed.has(dedupKey)) continue;
      claimed.add(dedupKey);
      survivors.push(s);
    }
    row.secondaryContacts = survivors.length > 0 ? survivors : undefined;
  }
}
