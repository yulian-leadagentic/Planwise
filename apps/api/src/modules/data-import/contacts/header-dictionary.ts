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
    'name', 'contact', 'contact person', 'poc', 'full name', 'given name',
    'first name', 'last name',
  ],
  company: [
    'חברה', 'שם חברה', 'משרד', 'שם המשרד', 'ארגון', 'גוף',
    'company', 'office', 'firm', 'organization', 'organisation',
    'business name', 'company name',
  ],
  discipline: [
    'תחום', 'מקצוע', 'עיסוק',
    'discipline', 'field', 'trade', 'domain', 'specialty', 'speciality',
    // §4 note: this is the discipline axis → maps to
    // `project-partner-roles.discipline` (Stage 6 wiring).
  ],
  role: [
    'תפקיד',
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

/**
 * Try to map a single header cell to a canonical field.
 *   1. exact normalized match wins ("email" → email)
 *   2. substring match — a dictionary needle appears inside the header
 *      OR the header is contained inside a needle (both directions)
 *      as long as the shorter side is length ≥ 3 (§4: "len ≥ 3").
 * Returns null when no confident match exists.
 */
export function matchHeaderToField(rawHeader: string): ContactField | null {
  if (!rawHeader) return null;
  const norm = normalizeHeader(rawHeader);
  if (!norm) return null;

  // Exact hit.
  const exact = NORMALIZED_INDEX.get(norm);
  if (exact) return exact;

  // Substring hit — walk once, prefer the longest needle so
  // "workemail" beats "email" only when both are in play.
  let best: { field: ContactField; needleLen: number } | null = null;
  for (const [needle, field] of NORMALIZED_INDEX) {
    const shorter = Math.min(needle.length, norm.length);
    if (shorter < 3) continue;
    if (norm.includes(needle) || needle.includes(norm)) {
      if (!best || needle.length > best.needleLen) {
        best = { field, needleLen: needle.length };
      }
    }
  }
  return best?.field ?? null;
}

/**
 * Score a candidate header row: how many of its non-empty cells match
 * a canonical field? Duplicates (same field matched twice) count once
 * toward the score — a header row with two "email" columns is still a
 * table, but the second column isn't extra evidence of header-ness.
 */
export function scoreHeaderRow(row: readonly string[]): {
  score: number;
  matched: Map<number, ContactField>;
} {
  const matched = new Map<number, ContactField>();
  const seen = new Set<ContactField>();
  let score = 0;
  row.forEach((cell, idx) => {
    if (!cell) return;
    const field = matchHeaderToField(cell);
    if (!field) return;
    matched.set(idx, field);
    if (!seen.has(field)) {
      seen.add(field);
      score++;
    }
  });
  return { score, matched };
}
