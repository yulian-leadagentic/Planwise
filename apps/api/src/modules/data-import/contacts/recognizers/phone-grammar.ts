/**
 * BM2 · Contacts import · Stage 4 (QA4 IMP-4) — Israeli phone grammar.
 *
 * A token is classified as a phone when, after stripping punctuation
 * (`.` `-` `(` `)` whitespace), it matches one of the following:
 *
 *   • Mobile:    `05[0-9]{8}`           →  05[0-9]-XXXXXXX
 *   • Landline:  `0[2-489][0-9]{7}`     →  0[2-9]-XXXXXXX (no 05)
 *   • Toll-free: `1[0-9]{6,7}`          →  1-XXX-XXX(X)
 *   • Intl IL:   `+972[0-9]{8,9}`       → normalized to 0-leading
 *
 * The grammar is deliberately narrow: an accidental phone-shaped number
 * inside a name ("שרית 2") won't match because it's below the digit
 * minimum. Confidence is 1.0 for a full match, 0.5 for a stripped-only
 * digit run of ≥ 7 digits that starts with `0` (a mostly-normal number
 * with unexpected extras) — used when the recognizer chain has to fall
 * back and the caller still wants to keep the value.
 *
 * `officeManager` is not a phone type — see `titles.ts` for role
 * synonyms.
 */

export type PhoneKind = 'mobile' | 'landline' | 'toll-free' | 'international';

export interface PhoneMatch {
  kind: PhoneKind;
  /** Normalized form: leading 0 (or `1` for toll-free), no separators. */
  value: string;
  /** Original token as it appeared in the source cell — preserved for display. */
  raw: string;
  /** 0..1; 1.0 = full grammar hit, 0.5 = permissive fallback. */
  confidence: number;
}

/** Characters we strip before running the grammar. */
const PHONE_PUNCT = /[\s().\-‐-―]/g;

const RE_MOBILE = /^05[0-9]{8}$/;
const RE_LANDLINE = /^0[2-489][0-9]{7}$/; // no 05 (that's mobile), no 07 (mobile-forward), no 06/00.
const RE_TOLL_FREE = /^1[0-9]{6,7}$/;
const RE_INTL_IL = /^\+972[0-9]{8,9}$/;

/**
 * Classify one token. Returns null if the token is not phone-shaped.
 * The classifier stays token-scoped — chunking is caller's job.
 */
export function classifyPhoneToken(rawToken: string): PhoneMatch | null {
  const raw = rawToken.trim();
  if (!raw) return null;
  const stripped = raw.replace(PHONE_PUNCT, '');
  if (!stripped) return null;

  // International first — `+` is a distinctive marker so a stripped-run
  // match without a leading `+` should NOT count as international.
  if (RE_INTL_IL.test(stripped)) {
    return {
      kind: 'international',
      value: '0' + stripped.slice(4),
      raw,
      confidence: 1,
    };
  }

  // A stripped run that isn't all digits (letters, symbols) fails.
  if (!/^\d+$/.test(stripped)) return null;

  if (RE_MOBILE.test(stripped)) {
    return { kind: 'mobile', value: stripped, raw, confidence: 1 };
  }
  if (RE_LANDLINE.test(stripped)) {
    return { kind: 'landline', value: stripped, raw, confidence: 1 };
  }
  if (RE_TOLL_FREE.test(stripped)) {
    return { kind: 'toll-free', value: stripped, raw, confidence: 1 };
  }

  // Permissive fallback — a 7-10 digit run beginning with `0`. Not
  // enough to say "mobile vs. landline" so we tag it landline, the
  // safer default (mobile forwarding still routes correctly, whereas
  // the reverse doesn't).
  if (/^0\d{6,9}$/.test(stripped)) {
    return { kind: 'landline', value: stripped, raw, confidence: 0.5 };
  }

  return null;
}

/**
 * True when the token looks phone-shaped. Cheap boolean sibling for
 * places that don't need the parsed struct.
 */
export function looksLikePhone(rawToken: string): boolean {
  return classifyPhoneToken(rawToken) != null;
}
