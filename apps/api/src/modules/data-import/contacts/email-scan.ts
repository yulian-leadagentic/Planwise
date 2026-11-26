/**
 * Review 2 (B2) · Email matching in linear time.
 *
 * The import used unanchored patterns like /[\w.+-]+@[\w-]+.../ on every
 * cell, document line and email header. On text with long runs of word
 * characters the engine retries the local part from every position: 40k
 * characters took 1.4 to 2.3 s, growing as n². A 200k-character cell
 * would block the event loop for about a minute.
 *
 * Instead of running such a pattern over the whole text, each '@' is
 * found with indexOf, its local part is read backwards (at most 64
 * characters, RFC 5321) and only the domain is matched, with a sticky,
 * bounded pattern placed right after the '@'. The result is the same as
 * the leftmost-first matches of the bounded pattern
 * `[\w.+-]{1,64}@<domain>`, at a cost proportional to the text length.
 */

/** RFC 5321 limit on the part before the '@'. */
export const EMAIL_MAX_LOCAL_PART = 64;

/** `\w . + -`, the local-part characters the import's patterns allow. */
function isLocalChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    code === 0x2e || // .
    code === 0x2b || // +
    code === 0x2d // -
  );
}

/**
 * Domain grammars, each sticky (`y`) and bounded (labels of at most 63
 * characters, a TLD of at most 24 letters).
 */
export const EMAIL_DOMAIN = {
  /** `[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}`: the "is there an address in here" check. */
  dotted: /[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[a-z]{2,24}/iy,
  /** `[\w-]+\.[a-z]{2,}`: the PDF address count. */
  single: /[\w-]{1,63}\.[a-z]{2,24}/iy,
  /** RFC-shaped host names: the address extraction in Stage 4. */
  hostname: /[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,8}/iy,
} as const;

export interface EmailHit {
  start: number;
  end: number;
}

/** Non-overlapping, leftmost-first address matches in `text`. */
export function findEmails(text: string, domain: RegExp, limit = Number.POSITIVE_INFINITY): EmailHit[] {
  const hits: EmailHit[] = [];
  let floor = 0; // a match never starts inside the previous one
  // A plain loop rather than indexOf per '@': a text of nothing but '@'
  // would otherwise pay a call per character.
  for (let at = 0; at < text.length && hits.length < limit; at++) {
    if (text.charCodeAt(at) !== 0x40 /* @ */) continue;
    const lowest = at - EMAIL_MAX_LOCAL_PART;
    const min = floor > lowest ? floor : lowest;
    let start = at;
    while (start > min && isLocalChar(text.charCodeAt(start - 1))) start--;
    if (start === at) continue;
    domain.lastIndex = at + 1;
    const m = domain.exec(text);
    if (!m) continue;
    const end = at + 1 + m[0].length;
    hits.push({ start, end });
    floor = end;
    at = end - 1;
  }
  return hits;
}

/** Does `text` contain an email address anywhere? */
export function containsEmail(text: string): boolean {
  return text.indexOf('@') >= 0 && findEmails(text, EMAIL_DOMAIN.dotted, 1).length > 0;
}

/** The matched address strings. */
export function extractEmails(text: string, domain: RegExp): string[] {
  return findEmails(text, domain).map((h) => text.slice(h.start, h.end));
}

/**
 * Anchored "the whole value is one address" checks stay as regexes (they
 * only run from position 0), but an address is never longer than 254
 * characters, so longer values are not even tested.
 */
export const EMAIL_MAX_LENGTH = 254;

const BOUNDED_EMAIL = '[\\w.+-]{1,64}@[\\w.-]{1,255}\\.[a-z]{2,24}';
/** `"Quoted Name" <addr>` or `Name <addr>`, tried at one position (sticky). */
const NAME_EMAIL_AT = new RegExp(`(?:"([^"]+)"\\s*|([^,<;]+?))<(${BOUNDED_EMAIL})>`, 'iy');
/** Only the quoted form, for a '"' that does not follow a delimiter. */
const QUOTED_NAME_EMAIL_AT = new RegExp(`"([^"]+)"\\s*<(${BOUNDED_EMAIL})>`, 'iy');

export interface NamedEmail {
  /** Display name as written, untrimmed (may be empty). */
  name: string;
  email: string;
}

/**
 * Every `Name <address>` / `"Name" <address>` pair in a header line, the
 * same pairs as the old
 *   /(?:"([^"]+)"|([^,<;]+?))\s*<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/gi
 * (with a bounded address) but without its quadratic retries.
 *
 * Why only some start positions are tried: an unquoted name cannot hold
 * `,` `<` `;`, so for any match the leftmost possible start is the
 * previous match's end or the character after the last such delimiter;
 * a quoted name starts at a '"'. Trying exactly those positions, in
 * order, finds the regex's own leftmost match. Each try scans forward
 * only to the next delimiter (or the next '"'), so every character is
 * scanned a bounded number of times. (The old `\s*` after an unquoted
 * name is dropped: the name keeps the trailing spaces instead, and the
 * caller trims it.)
 */
export function findNamedEmails(line: string): NamedEmail[] {
  const out: NamedEmail[] = [];
  if (line.indexOf('<') < 0 || line.indexOf('@') < 0) return out;
  let last = 0;
  for (let p = 0; p < line.length; p++) {
    const prev = p > 0 ? line.charCodeAt(p - 1) : -1;
    const boundary = p === last || prev === 0x2c /* , */ || prev === 0x3c /* < */ || prev === 0x3b; /* ; */
    if (!boundary && line.charCodeAt(p) !== 0x22 /* " */) continue;
    const re = boundary ? NAME_EMAIL_AT : QUOTED_NAME_EMAIL_AT;
    re.lastIndex = p;
    const m = re.exec(line);
    if (!m) continue;
    out.push(boundary ? { name: m[1] ?? m[2] ?? '', email: m[3] } : { name: m[1], email: m[2] });
    last = re.lastIndex;
    p = last - 1;
  }
  return out;
}

/**
 * Bare addresses between delimiters (start of line, whitespace, `,` `;`).
 * The leading delimiter anchors every attempt, so with the bounded
 * address this stays linear as a plain regex.
 */
export const BARE_EMAIL_RE = new RegExp(`(^|[\\s,;])(${BOUNDED_EMAIL})(?=$|[\\s,;])`, 'gi');
