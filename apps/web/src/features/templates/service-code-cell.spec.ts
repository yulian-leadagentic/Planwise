/**
 * QA6 round 2 (26.11) · finding 4: Templates › Services showed "—" in the
 * Code column for project phases. It now shows a muted "No code", and the
 * page (with the shared DataTable it renders) has no long dash left in
 * any text the user sees.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServiceCodeCell } from './service-code-cell';

const LONG_DASH = /[—–]/;
const render = (code: string | null | undefined) => renderToStaticMarkup(createElement(ServiceCodeCell, { code }));

describe('ServiceCodeCell', () => {
  it.each([null, undefined, '', '   '])('no code (%j) is a muted "No code", not a dash', (code) => {
    const html = render(code);
    expect(html).toContain('No code');
    expect(html).toContain('text-slate-400');
    expect(html).not.toMatch(LONG_DASH);
  });

  it('a code is shown as its pill', () => {
    const html = render('BIM');
    expect(html).toContain('>BIM<');
    expect(html).not.toContain('No code');
  });
});

/** The source without comments, so only code and rendered text remain. */
function codeOnly(file: string): string {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Templates › Services · no long dash in user-visible text', () => {
  it.each(['./services-page.tsx', './service-code-cell.tsx', '../../components/shared/data-table.tsx'])('%s', (file) => {
    const offending = codeOnly(file)
      .split('\n')
      .filter((line) => LONG_DASH.test(line));
    expect(offending).toEqual([]);
  });
});
