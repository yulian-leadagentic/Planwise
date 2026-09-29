/**
 * BM2 · Contacts import · Stage 4 (QA4 IMP-4) — Cell classifier.
 *
 * The Design Principle in `docs/bm2/qa4-import-preview.md` boils down
 * to two moves: tokenize each cell, then classify each token by TYPE
 * (email/phone/url/role/city/name), column-agnostic, each with a
 * confidence. This file implements exactly that — deterministic, no
 * ML — and packages the result into an `AssembledCell` that Stage 4's
 * split-merge can pull into its ResolvedRow shape.
 *
 * The classifier does NOT know about columns. Whether the input cell
 * came from the phone column, the notes column, or the company column
 * is up to the caller — but the same code assembles primary +
 * secondary contacts regardless.
 */

import { classifyPhoneToken, PhoneMatch } from './phone-grammar';
import { matchCity } from './cities';
import { matchTitle } from './titles';

// ─── Types ─────────────────────────────────────────────────────────────

export type TokenType = 'email' | 'phone' | 'url' | 'title' | 'city' | 'name' | 'unknown';

export interface Token {
  type: TokenType;
  value: string;
  raw: string;
  confidence: number;
  /** Present when `type === 'phone'`. */
  phone?: PhoneMatch;
}

export interface AssembledCell {
  /** Every token in the cell, in source order, with its typed classification. */
  tokens: Token[];
  /** All phone-shaped tokens, in source order. */
  phones: PhoneMatch[];
  /** All email-shaped tokens, in source order. */
  emails: string[];
  /**
   * The name assembled from consecutive name tokens (joined with
   * space). Undefined when no name-shaped token survived the chain.
   * Note that a title token in the middle splits the name run — e.g.
   * "דפנה מזכירה" would yield name "דפנה" + title "מזכירה".
   */
  name?: string;
  /**
   * The location note. Populated by either the city dictionary hit
   * OR the "part after ` - `" heuristic (which lets an unseen city
   * still extract). Confidence is 1 for a dictionary hit, 0.5 for
   * the trailing-fragment fallback.
   */
  city?: { value: string; confidence: number };
  /** Any dictionary-matched title (secretary, engineer, PM, …). */
  title?: string;
}

// ─── Regex ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[a-z]{2,}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
/** Hebrew or Latin letters (at least one) → name candidate. */
const HAS_LETTER_RE = /[A-Za-z֐-׿]/;

// ─── Tokenizer ─────────────────────────────────────────────────────────

/**
 * Split on whitespace, commas, semicolons, newlines. Hyphens are
 * preserved INSIDE a token because they belong to phone numbers
 * (`03-1234567`) and hyphenated city names (`תל-אביב`). Space-hyphen-
 * space is preserved as a bare `-` token so downstream city-detection
 * can spot the "after ` - `" location suffix.
 */
function tokenize(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  // Insert a standalone `-` where a space-hyphen-space appears so it
  // doesn't glue onto the next word (city recognition uses it).
  const spaced = trimmed.replace(/\s+-\s+/g, ' - ');
  return spaced
    .split(/[\s,;\n\r]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ─── Recognizer chain ─────────────────────────────────────────────────

function classifyToken(raw: string): Token {
  const t = raw.trim();
  if (!t) return { type: 'unknown', value: '', raw, confidence: 0 };

  // Email
  if (EMAIL_RE.test(t)) return { type: 'email', value: t.toLowerCase(), raw: t, confidence: 1 };

  // Phone — Israeli grammar
  const phone = classifyPhoneToken(t);
  if (phone) return { type: 'phone', value: phone.value, raw: t, confidence: phone.confidence, phone };

  // URL
  if (URL_RE.test(t)) return { type: 'url', value: t, raw: t, confidence: 1 };

  // Title
  const title = matchTitle(t);
  if (title) return { type: 'title', value: title, raw: t, confidence: 1 };

  // City (single-token hit)
  const cityHit = matchCity(t);
  if (cityHit) return { type: 'city', value: cityHit, raw: t, confidence: 1 };

  // Name — anything alphabetic that matched nothing above.
  if (HAS_LETTER_RE.test(t)) {
    // A bare `-` is not a name; skip it explicitly so the tokenizer
    // marker for "space-hyphen-space" never leaks into name assembly.
    if (t === '-' || /^[-‐-―]+$/.test(t)) {
      return { type: 'unknown', value: t, raw: t, confidence: 0 };
    }
    // Numeric noise mixed with a letter is suspicious — lower confidence.
    const hasDigit = /\d/.test(t);
    return { type: 'name', value: t, raw: t, confidence: hasDigit ? 0.5 : 1 };
  }

  return { type: 'unknown', value: t, raw: t, confidence: 0 };
}

// ─── Assembly ─────────────────────────────────────────────────────────

/**
 * Split the cell on the LAST `" - "` (space-hyphen-space) to peel off
 * a trailing location fragment. Returns `{head, tail}` where `head`
 * is the body of the cell (name + phone) and `tail` is the location
 * (or empty when no such delimiter exists).
 *
 * We split on the LAST occurrence so a hyphenated city name inside
 * the location fragment ("תל -אביב") still travels intact.
 */
function peelLocationSuffix(cell: string): { head: string; tail: string } {
  const trimmed = cell.trim();
  // Match a space, then a hyphen, then optional whitespace at the
  // right of a location fragment. We look for the LAST separator so
  // "תל -אביב" as a city keeps its internal hyphen. Regex is greedy
  // by nature; use lastIndexOf with the exact " - " sequence for a
  // conservative split; when absent, look for a trailing " -" boundary.
  const idx = trimmed.lastIndexOf(' - ');
  if (idx > 0) {
    return { head: trimmed.slice(0, idx).trim(), tail: trimmed.slice(idx + 3).trim() };
  }
  return { head: trimmed, tail: '' };
}

/**
 * Run the full classifier on one cell and return an AssembledCell.
 * `expectedType` is a hint (the mapped column: 'phone' | 'email' |
 * …) — used to bias low-confidence assemblies. Nothing about the
 * classification depends on it; it only steers confidence.
 */
export function classifyCell(cell: string): AssembledCell {
  const { head, tail } = peelLocationSuffix(cell);
  const bodyTokens = tokenize(head).map(classifyToken);
  const tailTokens = tail ? tokenize(tail).map(classifyToken) : [];

  const tokens: Token[] = [...bodyTokens, ...tailTokens];

  const phones: PhoneMatch[] = [];
  const emails: string[] = [];
  let title: string | undefined;
  let cityFromTokens: { value: string; confidence: number } | undefined;
  const nameFragments: string[] = [];

  // Body pass — collect phones, emails, titles, names. Consecutive
  // name tokens fuse into one display name; any typed token (phone/
  // email/title/city) breaks the run so downstream assembly doesn't
  // glue "רבקה 09-9588808" into a single name.
  let currentNameRun: string[] = [];
  const flushName = () => {
    if (currentNameRun.length > 0) {
      nameFragments.push(currentNameRun.join(' '));
      currentNameRun = [];
    }
  };
  for (const tok of bodyTokens) {
    if (tok.type === 'phone' && tok.phone) {
      phones.push(tok.phone);
      flushName();
    } else if (tok.type === 'email') {
      emails.push(tok.value);
      flushName();
    } else if (tok.type === 'title' && !title) {
      title = tok.value;
      flushName();
    } else if (tok.type === 'city') {
      cityFromTokens = { value: tok.value, confidence: 1 };
      flushName();
    } else if (tok.type === 'name') {
      currentNameRun.push(tok.value);
    } else {
      flushName();
    }
  }
  flushName();

  // Trailing-fragment pass — prefer a city hit; fall back to "the
  // whole tail is the city" (confidence 0.5) when no dictionary match.
  if (tail) {
    const tailCityHit = tailTokens.find((t) => t.type === 'city');
    if (tailCityHit) {
      cityFromTokens = { value: tailCityHit.value, confidence: 1 };
    } else if (!cityFromTokens) {
      // Reconstruct tail without embedded hyphens for a readable value.
      const readable = tail
        .replace(/\s*[-‐-―]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      cityFromTokens = { value: readable, confidence: 0.5 };
    }
  }

  return {
    tokens,
    phones,
    emails,
    name: nameFragments.length > 0 ? nameFragments.join(' ') : undefined,
    city: cityFromTokens,
    title,
  };
}
