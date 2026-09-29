/**
 * BM2 · Contacts import · Stage 4 (QA4 IMP-4) — City dictionary.
 *
 * A small, extensible list of Israeli cities the classifier uses to
 * decide whether a token (usually the fragment after `" - "` in a
 * phone cell) is a location note. Add new cities as they appear in
 * real files — the recognizer chain in `classifier.ts` also has a
 * "part after ` - `" heuristic so an unseen city still gets extracted;
 * this list adds a first-class hit for the common ones.
 *
 * Normalization: entries are stored lowercased and stripped of
 * hyphens/whitespace so the matcher can compare against a cell like
 * "תל -אביב" or "TEL-AVIV" without listing every spelling.
 */

const CITY_ENTRIES = [
  'חיפה',
  'תל אביב',
  'תל-אביב',
  'ירושלים',
  'נתניה',
  'הרצליה',
  'רמת גן',
  'פתח תקווה',
  'רעננה',
  'כפר סבא',
  'אשדוד',
  'אשקלון',
  'חדרה',
  'נהריה',
  'עכו',
  'ראשון לציון',
  'חולון',
  'בת ים',
  'בני ברק',
  'רחובות',
  'קריית שמונה',
  'מודיעין',
  'באר שבע',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s‐-―-]+/g, '') // whitespace + hyphens/dashes
    .trim();
}

const NORMALIZED_CITIES = new Set(CITY_ENTRIES.map(normalize));

/**
 * True when `token` matches a known city (case-, hyphen- and
 * whitespace-insensitive). Callers should pass one token at a time or
 * a small trailing fragment (`" - <city>"` after splitting the cell).
 */
export function matchCity(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const norm = normalize(t);
  if (norm.length < 3) return null;
  if (NORMALIZED_CITIES.has(norm)) {
    // Return the token in its human-friendly form (e.g. "תל -אביב"
    // → "תל אביב") — collapse embedded dashes to a single space.
    return t.replace(/\s*[-‐-―]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}
