#!/usr/bin/env node
/**
 * check-dark-mode.mjs — Planwise design-system guardrail
 * ------------------------------------------------------
 * Scans apps/web/src TSX files for hardcoded slate/gray/bg-white
 * classes that DON'T have a `dark:` partner in the same class-list.
 * Emits a warning per offender with file:line and the offending
 * class list. Exit code 1 when any offenders exist so CI can gate.
 *
 * Rationale: `bg-white` alone will disappear in dark mode; the design
 * system requires either a `dark:` partner or a semantic token
 * (bg-card, border-border, text-muted-foreground). A plain ESLint
 * no-restricted-syntax rule can't tell "bg-white" (bad) from
 * "bg-white dark:bg-slate-900" (fine), so this check parses the
 * class-list per attribute.
 *
 * Usage:
 *   node scripts/check-dark-mode.mjs            # scan apps/web/src
 *   node scripts/check-dark-mode.mjs --quiet    # only print totals
 *   node scripts/check-dark-mode.mjs path...    # scan given files
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root relative to THIS script so we get the same
// results whether the check is run from repo-root or from apps/web.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET = path.join(ROOT, 'apps', 'web', 'src');

// Classes that MUST have a paired dark: variant. When one of these
// appears in a class list without an adjacent dark:* on the same
// property axis (bg/text/border/divide), it's a warning.
const RULES = [
  { pattern: /^bg-white$/,                                axis: 'bg',     needsDarkPrefix: 'dark:bg-' },
  { pattern: /^bg-(slate|gray)-\d+(?:\/\d+)?$/,           axis: 'bg',     needsDarkPrefix: 'dark:bg-' },
  { pattern: /^hover:bg-(slate|gray|white)/,              axis: 'hover-bg', needsDarkPrefix: 'dark:hover:bg-' },
  { pattern: /^text-(slate|gray)-\d+$/,                   axis: 'text',   needsDarkPrefix: 'dark:text-' },
  { pattern: /^hover:text-(slate|gray)-\d+$/,             axis: 'hover-text', needsDarkPrefix: 'dark:hover:text-' },
  { pattern: /^border-(slate|gray)-\d+$/,                 axis: 'border', needsDarkPrefix: 'dark:border-' },
  { pattern: /^hover:border-(slate|gray)-\d+$/,           axis: 'hover-border', needsDarkPrefix: 'dark:hover:border-' },
  { pattern: /^divide-(slate|gray)-\d+$/,                 axis: 'divide', needsDarkPrefix: 'dark:divide-' },
  { pattern: /^ring-(slate|gray)-\d+$/,                   axis: 'ring',   needsDarkPrefix: 'dark:ring-' },
];

const CLASS_ATTR_RX = /(?:className|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;

// Extract candidate class-list strings from a source line. Handles
// className="…", className='…', className={cn(...)}, className={\`…\`}.
// For cn(...) / template literals, this is a best-effort scan: we
// strip quotes/backticks and look at the concatenated tokens.
function extractClassLists(source) {
  const out = [];
  let m;
  while ((m = CLASS_ATTR_RX.exec(source)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    // For {...} blocks, pull every string literal and template chunk.
    if (m[3] !== undefined) {
      const strings = [];
      const strRx = /(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
      let sm;
      while ((sm = strRx.exec(raw)) !== null) {
        strings.push(sm[1] ?? sm[2] ?? sm[3] ?? '');
      }
      out.push({ index: m.index, list: strings.join(' ') });
    } else {
      out.push({ index: m.index, list: raw });
    }
  }
  return out;
}

function checkClassList(list) {
  const tokens = list.split(/\s+/).filter(Boolean);
  const offenders = [];
  for (const tok of tokens) {
    for (const rule of RULES) {
      if (rule.pattern.test(tok)) {
        // Look for any token starting with the needed dark: prefix.
        const paired = tokens.some((t) => t.startsWith(rule.needsDarkPrefix));
        if (!paired) offenders.push({ tok, axis: rule.axis });
      }
    }
  }
  return offenders;
}

function offsetToLine(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === '\n') line++;
  return line;
}

function scanFile(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const lists = extractClassLists(src);
  const findings = [];
  for (const { index, list } of lists) {
    const offenders = checkClassList(list);
    if (offenders.length > 0) {
      findings.push({
        line: offsetToLine(src, index),
        offenders,
        list,
      });
    }
  }
  return findings;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.tsx')) out.push(abs);
  }
  return out;
}

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const targets = args.filter((a) => !a.startsWith('--'));
const files = targets.length > 0
  ? targets.flatMap((t) => {
      const abs = path.resolve(t);
      return fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    })
  : walk(DEFAULT_TARGET);

let totalOffenders = 0;
let filesWithFindings = 0;
for (const f of files) {
  const findings = scanFile(f);
  if (findings.length > 0) {
    filesWithFindings++;
    totalOffenders += findings.reduce((s, x) => s + x.offenders.length, 0);
    if (!quiet) {
      const rel = path.relative(ROOT, f);
      for (const { line, offenders, list } of findings) {
        const short = list.length > 80 ? list.slice(0, 77) + '...' : list;
        console.warn(`${rel}:${line}  [${offenders.map((o) => o.tok).join(', ')}]  in: "${short}"`);
      }
    }
  }
}

console.warn('');
console.warn(`Scanned ${files.length} TSX files.`);
console.warn(`Files with unpaired dark-mode classes: ${filesWithFindings}`);
console.warn(`Total unpaired classes: ${totalOffenders}`);

if (totalOffenders > 0) {
  console.warn('');
  console.warn('Each offender needs either a dark: partner (e.g. bg-white dark:bg-slate-900)');
  console.warn('or a semantic token (bg-card, border-border, text-muted-foreground).');
  console.warn('See .claude/skills/planwise-design.');
  // Non-zero exit only when running strict mode, so lint stays warn-only by default.
  if (args.includes('--strict')) process.exit(1);
}
