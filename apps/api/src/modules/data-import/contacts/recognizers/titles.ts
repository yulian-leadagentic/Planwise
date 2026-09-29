/**
 * BM2 · Contacts import · Stage 4 (QA4 IMP-4) — Title / role dictionary.
 *
 * Job titles the classifier uses to tag a token as a role rather than
 * a name. Extend this list as new titles show up in the real files —
 * unmatched Hebrew/Latin words fall through to the `name` recognizer,
 * so the failure mode is "the title becomes part of the person's
 * display name", which is inspectable + editable in the Preview.
 *
 * Matching is case- and gender-tolerant: entries are pre-normalized
 * (stripped of Hebrew niqqud, whitespace, punctuation) so a variant
 * spelling still matches.
 */

const TITLE_ENTRIES = [
  // Office / secretariat
  'מזכירה',
  'מזכיר',
  'מנהלת משרד',
  'מנהל משרד',
  'עוזרת אישית',
  'עוזר אישי',
  'רכזת',
  'רכז',
  'רכזת פרויקטים',
  'רכז פרויקטים',
  // Consultant / advisor
  'יועץ',
  'יועצת',
  'יועץ בכיר',
  'יועצת בכירה',
  // Design / engineering
  'אדריכל',
  'אדריכלית',
  'מהנדס',
  'מהנדסת',
  'מתכנן',
  'מתכננת',
  'מעצב',
  'מעצבת',
  'קונסטרוקטור',
  // PM
  'מנהל פרויקט',
  'מנהלת פרויקט',
  'מנהל פרוייקט',
  'מנהלת פרוייקט',
  'ראש צוות',
  'ראשת צוות',
  // Latin
  'PM',
  'project manager',
  'consultant',
  'architect',
  'engineer',
  'secretary',
  'office manager',
  'assistant',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[֑-ׇ]+/g, '') // strip Hebrew niqqud + cantillation
    .replace(/[\s‐-―.\-'"׳״]+/g, '') // punctuation + hyphens
    .trim();
}

const NORMALIZED_TITLES = new Map<string, string>();
for (const entry of TITLE_ENTRIES) NORMALIZED_TITLES.set(normalize(entry), entry);

/**
 * Try to match `token` against a known title. Returns the canonical
 * form on hit (the raw dictionary entry — the same casing you would
 * write in a form), or null.
 */
export function matchTitle(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const norm = normalize(t);
  if (!norm) return null;
  return NORMALIZED_TITLES.get(norm) ?? null;
}

/**
 * The default title assigned to a secondary contact extracted from
 * the phone/company cell — see the "worked example" in
 * `docs/bm2/qa4-import-preview.md`. QA calls these "office managers"
 * whether the actual role is secretary, PA, or receptionist; the PM
 * can edit the value inline before commit (QA4 IMP-2).
 */
export const DEFAULT_SECONDARY_TITLE = 'Office manager';
