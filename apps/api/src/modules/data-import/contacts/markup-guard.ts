/**
 * Review 2 (B1, B3) · Cheap, linear checks on the XML / HTML inside an
 * upload, run BEFORE a parser that would otherwise do far more work than
 * the file's size suggests:
 *   • ODF content.xml (our own regex extraction for .odt, SheetJS for
 *     .ods): broken markup makes those regexes rescan the rest of the
 *     text for every unclosed tag, and ODS repeat attributes make SheetJS
 *     store rows x columns copies of one cell;
 *   • xlsx worksheet XML: SheetJS materialises every filled cell of the
 *     first 20,001 rows, whatever the columns (6.6 million cells from a
 *     6.5 MB file took 8.6 s and 1.4 GB of heap);
 *   • HTML tables: SheetJS compares every cell with every merged range
 *     seen so far (16,000 `colspan` cells took 0.3 s, growing as n²).
 */

import { CONTACTS_IMPORT_MAX_ROWS } from './import-limits';

type TagKind = 'open' | 'close' | 'self';

/**
 * Visit every tag of `text` in one pass. Returns false when the markup is
 * broken in a way that makes regex-based parsers rescan the remaining
 * text: a '<' without a '>' before the next '<', or a comment, CDATA
 * section or processing instruction that is never closed.
 */
function walkTags(
  text: string,
  visit: (kind: TagKind, name: string, tagStart: number, tagEnd: number) => boolean | void,
): boolean {
  let i = text.indexOf('<');
  while (i >= 0) {
    let skipTo = -1;
    if (text.startsWith('<!--', i)) skipTo = closeOf(text, '-->', i + 4);
    else if (text.startsWith('<![CDATA[', i)) skipTo = closeOf(text, ']]>', i + 9);
    else if (text.startsWith('<?', i)) skipTo = closeOf(text, '?>', i + 2);
    if (skipTo !== -1) {
      if (skipTo < 0) return false;
      i = text.indexOf('<', skipTo);
      continue;
    }
    const end = text.indexOf('>', i + 1);
    const next = text.indexOf('<', i + 1);
    if (end < 0 || (next >= 0 && next < end)) return false;
    if (text.charCodeAt(i + 1) !== 0x21 /* '!' (DOCTYPE) */) {
      const closing = text.charCodeAt(i + 1) === 0x2f;
      let j = closing ? i + 2 : i + 1;
      const nameStart = j;
      while (j < end) {
        const ch = text.charCodeAt(j);
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x2f) break;
        j++;
      }
      const name = text.slice(nameStart, j);
      const kind: TagKind = closing ? 'close' : text.charCodeAt(end - 1) === 0x2f ? 'self' : 'open';
      if (visit(kind, name, i, end) === false) return false;
    }
    i = next;
  }
  return true;
}

/** Index just past `marker` (searched from `from`), or -2 when it never appears. */
function closeOf(text: string, marker: string, from: number): number {
  const at = text.indexOf(marker, from);
  return at < 0 ? -2 : at + marker.length;
}

function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/**
 * True when `xml` is well-formed enough for regex extraction to stay
 * linear: every tag closed in order, nesting at most `maxDepth` deep and
 * tables (`table:table`) nested at most `maxTableDepth` deep.
 */
export function isLinearSafeXml(xml: string, maxDepth = 256, maxTableDepth = 4): boolean {
  const stack: string[] = [];
  let tableDepth = 0;
  const ok = walkTags(xml, (kind, name) => {
    if (kind === 'open') {
      stack.push(name);
      if (stack.length > maxDepth) return false;
      if (name === 'table:table' && ++tableDepth > maxTableDepth) return false;
    } else if (kind === 'close') {
      if (stack.pop() !== name) return false;
      if (name === 'table:table') tableDepth--;
    }
    return true;
  });
  return ok && stack.length === 0;
}

function numericAttr(text: string, tagStart: number, tagEnd: number, attr: string): number {
  const tag = text.slice(tagStart, tagEnd);
  const at = tag.indexOf(attr + '=');
  if (at < 0) return 1;
  const before = at > 0 ? tag.charCodeAt(at - 1) : 0x20;
  // whole attribute name (optionally prefixed, e.g. table:number-rows-repeated)
  if (!(before === 0x20 || before === 0x3a || before === 0x09 || before === 0x0a || before === 0x0d)) return 1;
  const m = /^=\s*["']?(\d+)/.exec(tag.slice(at + attr.length, at + attr.length + 24));
  return m ? Math.max(1, Number(m[1])) : 1;
}

export interface OdsCellStats {
  /** Cells SheetJS would store (upper bound): repeats of filled cells expanded. */
  storedCells: number;
  /** Cell tags SheetJS parses. */
  cellTags: number;
}

/**
 * What SheetJS's ODS reader would build from this content.xml. It copies
 * a non-empty cell `number-rows-repeated` x `number-columns-repeated`
 * times (rows past `sheetRows` excepted), so one tag can mean billions of
 * cells. Null when the markup is broken (see walkTags).
 */
export function odsCellStats(xml: string, sheetRows = CONTACTS_IMPORT_MAX_ROWS + 1): OdsCellStats | null {
  let storedCells = 0;
  let cellTags = 0;
  let row = -1;
  let rowRepeat = 1;
  const ok = walkTags(xml, (kind, name, start, end) => {
    const local = localName(name);
    if (local === 'table' && kind === 'open') {
      row = -1;
      rowRepeat = 1;
    } else if (local === 'table-row') {
      if (kind === 'close') {
        row += rowRepeat;
        rowRepeat = 1;
      } else {
        if (row === -1) row = 0;
        rowRepeat = numericAttr(xml, start, end, 'number-rows-repeated');
      }
    } else if (local === 'table-cell' || local === 'covered-table-cell') {
      if (kind === 'close') return true;
      cellTags++;
      if (local === 'covered-table-cell' || row >= sheetRows) return true;
      storedCells += kind === 'self' ? 1 : rowRepeat * numericAttr(xml, start, end, 'number-columns-repeated');
    }
    return true;
  });
  return ok ? { storedCells, cellTags } : null;
}

export interface XmlTagCount {
  /** Every tag with this local name. */
  all: number;
  /** The ones that are not self-closing (for `<c>`: cells holding a value or formula). */
  withContent: number;
}

/**
 * Count tags by local name in raw XML bytes, one pass with indexOf (no
 * string conversion of the whole part). Used on xlsx parts: `c` (cells)
 * and `si` (shared strings).
 */
export function countXmlTags(data: Buffer, names: readonly string[]): Record<string, XmlTagCount> {
  const out: Record<string, XmlTagCount> = {};
  const targets = names.map((name) => {
    out[name] = { all: 0, withContent: 0 };
    return { bytes: Buffer.from(name, 'latin1'), count: out[name] };
  });
  let i = data.indexOf(0x3c);
  while (i >= 0) {
    let j = i + 1;
    const first = data[j];
    if (first === 0x2f || first === 0x3f || first === 0x21) {
      i = data.indexOf(0x3c, j);
      continue;
    }
    let colon = -1;
    while (j < data.length && j - i <= 64) {
      const ch = data[j];
      if (ch === 0x20 || ch === 0x3e || ch === 0x2f || ch === 0x09 || ch === 0x0a || ch === 0x0d) break;
      if (ch === 0x3a) colon = j;
      j++;
    }
    const start = colon >= 0 ? colon + 1 : i + 1;
    for (const target of targets) {
      if (target.bytes.length !== j - start) continue;
      let same = true;
      for (let k = 0; k < target.bytes.length; k++) {
        if (data[start + k] !== target.bytes[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      target.count.all++;
      const gt = data.indexOf(0x3e, j);
      if (gt > 0 && data[gt - 1] !== 0x2f) target.count.withContent++;
      break;
    }
    i = data.indexOf(0x3c, j);
  }
  return out;
}

export interface HtmlTableStats {
  cells: number;
  spans: number;
}

/**
 * Cell tags and `colspan` / `rowspan` attributes in an HTML text. SheetJS
 * checks every cell against every merged range, so its work grows with
 * cells x spans.
 */
export function htmlTableStats(text: string): HtmlTableStats {
  let cells = 0;
  let spans = 0;
  const cellRe = /<t[dh][\s>/]/gi;
  const spanRe = /(?:col|row)span/gi;
  while (cellRe.exec(text)) cells++;
  while (spanRe.exec(text)) spans++;
  return { cells, spans };
}
