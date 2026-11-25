import { describe, expect, it } from 'vitest';
import { CATALOG_LOCK_TOOLTIP } from './catalog-lock';

describe('PR-076 · Catalog lock badge tooltip', () => {
  it('says where the row is edited and what a change reaches', () => {
    expect(CATALOG_LOCK_TOOLTIP).toBe(
      'נערך ב-Task Catalog. שינוי חל על טמפלייטים ועל פרויקטים חדשים בלבד',
    );
  });

  it('has no long dashes', () => {
    expect(CATALOG_LOCK_TOOLTIP).not.toMatch(/[–—]/);
  });
});
