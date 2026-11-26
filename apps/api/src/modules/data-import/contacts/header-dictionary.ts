/**
 * BM2 · Contacts import · Stage 2 support — the header dictionary.
 *
 * Verbatim from `docs/bm2/bp-import-methodology.md` §4 — validated
 * against the real 246-file dataset. Adding a synonym here is the
 * primary way we widen "0-click" coverage as new client sheets land.
 *
 * Normalization convention (applied to BOTH the source header AND the
 * dictionary entry before comparison):
 *   • lowercase
 *   • strip quotes, dots, dashes, slashes, parens
 *   • collapse internal whitespace to nothing
 *   • trim
 *
 * Match strategy is exact-first, substring-fallback (min-length ≥ 3
 * to avoid a two-letter needle matching every word) — this mirrors §4:
 * "Match exact, then substring (len ≥ 3)."
 *
 * The dictionary is intentionally file-backed rather than DB-seeded:
 * dictionary updates ship with code changes (reproducible), and the
 * numbers in §4 come from *this* dictionary. Named user presets — a
 * separate concept — DO live in the DB and are added in Stage 3.
 */

/** Canonical field names we map source columns to. */
export const CONTACT_FIELDS = [
  'email',
  'mobile',
  'phone',
  'contact',
  'company',
  'discipline',
  'role',
  'address',
  'note',
] as const;
export type ContactField = typeof CONTACT_FIELDS[number];

/**
 * The dictionary. Values are the raw synonym strings — normalization is
 * applied at match time so a maintainer editing this file sees exactly
 * what the client's sheets say.
 *
 * The Hebrew / Latin mix is deliberate — every entry has been observed
 * in the real folder or in Amit's samples.
 */
export const HEADER_DICTIONARY: Record<ContactField, readonly string[]> = {
  email: [
    // Hebrew synonyms
    'מייל', 'אימייל', 'דוא״ל', 'דוא"ל', 'דואל',
    // BM2-28 (QA6) — "email address" in Hebrew. Without these the
    // substring rule picked the longer needle "כתובת" (address).
    'כתובת מייל', 'כתובת אימייל', 'כתובת דוא"ל', 'כתובת דואל',
    // Latin
    'e-mail', 'e.mail', 'email', 'mail', 'email address', 'e mail',
    'primary email', 'work email',
    // Google Contacts export column
    'e-mail 1 - value',
  ],
  mobile: [
    'נייד', 'סלולרי', 'פלאפון', "פלא'", 'פלא',
    'mobile', 'cell', 'cellular', 'cell phone', 'mobile phone',
  ],
  phone: [
    'טלפון', "טל'", 'ט. משרד', 'טלפון משרד', 'טל משרד',
    'phone', 'tel', 'telephone', 'landline', 'office phone', 'work phone',
  ],
  contact: [
    'שם', 'איש קשר', 'שם איש קשר', 'שם מלא',
    // QA4 D9 (2026-09-28) — real developer sheet columns:
    // "שם המתכנן" (planner name) is a person column even though it
    // reads more specialised than the generic "שם"; keep both so
    // dedup within a sheet still works.
    'שם המתכנן',
    // BM2-28 (QA6) — person-name headers seen in the client's real
    // folder that matched nothing, so the sheet had no name column and
    // no row met the "name AND (email OR phone)" floor.
    'שם פרטי', 'שם משפחה', 'איש הקשר', 'שם איש הקשר', 'אנשי קשר',
    'name', 'contact', 'contact person', 'poc', 'full name', 'given name',
    'first name', 'last name',
  ],
  company: [
    'חברה', 'שם חברה', 'משרד', 'שם המשרד', 'ארגון', 'גוף',
    // QA4 D9 (2026-09-28) — developer sheets frequently drop the
    // organization column under "שיוך" (affiliation) or a plural
    // "יועצים" (consultants). Both mean "the firm this person
    // belongs to on the project".
    'שיוך', 'יועצים',
    // BM2-28 (QA6) — supplier lists.
    'שם ספק', 'שם הספק',
    'company', 'office', 'firm', 'organization', 'organisation',
    'business name', 'company name',
  ],
  discipline: [
    'תחום', 'מקצוע', 'עיסוק',
    // QA4 D9 (2026-09-28) — Hebrew developer sheets commonly print
    // "דיסציפלינה" (a direct transliteration of "discipline") — a
    // header the substring rule caught only weakly. Explicit
    // dictionary entry gives it an exact hit.
    'דיסציפלינה',
    'discipline', 'field', 'trade', 'domain', 'specialty', 'speciality',
    // §4 note: this is the discipline axis → maps to
    // `project-partner-roles.discipline` (Stage 6 wiring).
  ],
  role: [
    'תפקיד',
    // QA4 D9 (2026-09-28) — real 260040-Contacts.xlsx uses "תפקיד
    // בפרויקט" (role on project). Same axis as the generic "תפקיד";
    // also captures "הרשאה" (permission/authority) which developers
    // sometimes use interchangeably with role on the stakeholder list.
    'תפקיד בפרויקט', 'הרשאה',
    'position', 'role', 'title', 'job title', 'jobtitle',
  ],
  address: [
    'כתובת',
    'address', 'street', 'location',
  ],
  note: [
    'הערות', 'הערה',
    'notes', 'note', 'comment', 'comments', 'remarks',
  ],
};

/**
 * BM2-28 (QA6) — fallback synonyms. They name a column only when the
 * row has no regular (dictionary) column for the same field, and only on
 * an exact match (never by substring). Real sheets often carry BOTH
 * "שם היועץ" (the consultant, frequently the firm) and "איש קשר" (the
 * person); the person column must win, but when "שם היועץ" is the only
 * name column it is still the best name we have.
 */
export const FALLBACK_HEADER_SYNONYMS: Partial<Record<ContactField, readonly string[]>> = {
  contact: [
    'שם היועץ', 'שם יועץ', 'שם מתכנן', 'שם נציג', 'שם הנציג', 'נציג',
    'אחראי', 'שם האחראי', 'representative',
  ],
};

/**
 * Normalize a header cell for matching. Same routine used for the
 * dictionary lookup and for hashing headers into the header→field
 * cache. Never changes source data — the raw header is preserved
 * upstream and downstream for display.
 */
export function normalizeHeader(raw: string): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/["'׳״.\-\/\\()]+/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Pre-computed normalized synonym → field map. Built once at module
 * load so per-file header scoring is a cheap O(1) lookup.
 */
const NORMALIZED_INDEX: Map<string, ContactField> = (() => {
  const idx = new Map<string, ContactField>();
  for (const field of CONTACT_FIELDS) {
    for (const raw of HEADER_DICTIONARY[field]) {
      const key = normalizeHeader(raw);
      if (key) idx.set(key, field);
    }
  }
  return idx;
})();

/** Fallback synonyms, normalized. Exact match only. */
const FALLBACK_INDEX: Map<string, ContactField> = (() => {
  const idx = new Map<string, ContactField>();
  for (const field of CONTACT_FIELDS) {
    for (const raw of FALLBACK_HEADER_SYNONYMS[field] ?? []) {
      const key = normalizeHeader(raw);
      if (key && !NORMALIZED_INDEX.has(key)) idx.set(key, field);
    }
  }
  return idx;
})();

/**
 * How sure a header match is. When two columns of one row match the same
 * field, the stronger match names the column (leftmost on a tie).
 */
export const MATCH_EXACT = 3;
export const MATCH_SUBSTRING = 2;
export const MATCH_FALLBACK = 1;

export interface HeaderMatch {
  field: ContactField;
  strength: number;
}

/**
 * Try to map a single header cell to a canonical field.
 *   1. exact normalized match wins ("email" → email)
 *   2. substring match — a dictionary needle appears inside the header
 *      OR the header is contained inside a needle (both directions)
 *      as long as the shorter side is length ≥ 3 (§4: "len ≥ 3").
 *   3. BM2-28 — exact match against the fallback synonyms.
 * Returns null when no confident match exists.
 */
export function matchHeader(rawHeader: string): HeaderMatch | null {
  if (!rawHeader) return null;
  const norm = normalizeHeader(rawHeader);
  if (!norm) return null;

  // BM2-28 (QA6) — some PDFs come out of the text extractor with the
  // words of a Hebrew line in visual (reversed) order: "קשר איש" for
  // "איש קשר", "חברה שם" for "שם חברה". Try the reversed word order
  // too, so a multi-word header still matches.
  const words = rawHeader.trim().split(/\s+/);
  const reversed = words.length > 1 ? normalizeHeader([...words].reverse().join(' ')) : '';
  const candidates = reversed && reversed !== norm ? [norm, reversed] : [norm];

  // Exact hit.
  for (const candidate of candidates) {
    const exact = NORMALIZED_INDEX.get(candidate);
    if (exact) return { field: exact, strength: MATCH_EXACT };
  }

  // Substring hit — walk once, prefer the longest needle so
  // "workemail" beats "email" only when both are in play.
  let best: { field: ContactField; needleLen: number } | null = null;
  for (const candidate of candidates) {
    for (const [needle, field] of NORMALIZED_INDEX) {
      const shorter = Math.min(needle.length, candidate.length);
      if (shorter < 3) continue;
      if (candidate.includes(needle) || needle.includes(candidate)) {
        if (!best || needle.length > best.needleLen) {
          best = { field, needleLen: needle.length };
        }
      }
    }
  }
  if (best) return { field: best.field, strength: MATCH_SUBSTRING };

  for (const candidate of candidates) {
    const fallback = FALLBACK_INDEX.get(candidate);
    if (fallback) return { field: fallback, strength: MATCH_FALLBACK };
  }
  return null;
}

export function matchHeaderToField(rawHeader: string): ContactField | null {
  return matchHeader(rawHeader)?.field ?? null;
}

/**
 * Score a candidate header row: how many of its non-empty cells match
 * a canonical field? Duplicates (same field matched twice) count once
 * toward the score — a header row with two "email" columns is still a
 * table, but the second column isn't extra evidence of header-ness.
 *
 * `strength` holds each matched column's match strength so the caller
 * can let a dictionary column beat a fallback one for the same field.
 */
export function scoreHeaderRow(row: readonly string[]): {
  score: number;
  matched: Map<number, ContactField>;
  strength: Map<number, number>;
} {
  const matched = new Map<number, ContactField>();
  const strength = new Map<number, number>();
  const seen = new Set<ContactField>();
  let score = 0;
  row.forEach((cell, idx) => {
    if (!cell) return;
    const match = matchHeader(cell);
    if (!match) return;
    matched.set(idx, match.field);
    strength.set(idx, match.strength);
    if (!seen.has(match.field)) {
      seen.add(match.field);
      score++;
    }
  });
  return { score, matched, strength };
}
