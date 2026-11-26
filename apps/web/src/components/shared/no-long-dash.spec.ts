/**
 * QA6 round 3 (26.11) · no long dash in text the user sees (labels,
 * options, placeholders, titles, aria-labels) in the shared table, filter
 * and select components, the project list and the project form. An empty
 * value is a muted "None" / "All" (design system), not "—" or "— All —".
 *
 * Comments are excluded. Date ranges ("Sun 22 – Thu 26 Nov 2026",
 * "Nov 2026 – ללא תאריך סיום") are specified with a dash in the
 * requirements; none of these files builds one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColumnFilter } from './column-filter';

const LONG_DASH = /[—–]/;

/** The source without comments, so only code and rendered text remain. */
function codeOnly(url: URL): string {
  const src = readFileSync(url, 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function offendingLines(url: URL): string[] {
  return codeOnly(url)
    .split('\n')
    .filter((line) => LONG_DASH.test(line))
    .map((line) => line.trim());
}

/** Every component source in a directory (specs excluded: they name the dash on purpose). */
function sourcesIn(dir: string): string[] {
  return readdirSync(new URL(dir, import.meta.url))
    .filter((f) => /\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f))
    .map((f) => `${dir}${f}`);
}

describe('Shared table, filter and select components · no long dash in user-visible text', () => {
  const files = [...sourcesIn('./'), ...sourcesIn('../ui/')];

  it('scans the whole of components/shared and components/ui', () => {
    expect(files).toEqual(expect.arrayContaining(['./column-filter.tsx', './data-table.tsx', './multi-select-filter.tsx', './task-card-body.tsx']));
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s', (file) => {
    expect(offendingLines(new URL(file, import.meta.url))).toEqual([]);
  });
});

describe('Projects · no long dash in user-visible text', () => {
  it.each([
    '../../features/projects/project-list-page.tsx',
    '../../features/projects/project-form-page.tsx',
    '../../features/projects/project-edit-read-only.tsx',
    '../../features/projects/project-detail/project-info-tab.tsx',
  ])('%s', (file) => {
    expect(offendingLines(new URL(file, import.meta.url))).toEqual([]);
  });
});

describe('ColumnFilter · the empty choice', () => {
  it('reads "All", not "— All —"', () => {
    const html = renderToStaticMarkup(
      createElement(ColumnFilter, {
        config: { colKey: 'status', options: [{ value: 'active', label: 'Active' }] },
        value: '',
        onChange: () => {},
      }),
    );
    expect(html).toContain('<option value="" selected="">All</option>');
    expect(html).not.toMatch(LONG_DASH);
  });
});
