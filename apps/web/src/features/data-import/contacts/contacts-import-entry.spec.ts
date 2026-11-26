/**
 * BM2-28 (QA6) — Wizard convergence: every "Import contacts" entry point
 * opens the same wizard, the old bp-import-wizard is gone, no button is
 * dead (route reachable, permission identical to the API's guard), and
 * a bad file is refused in words before upload.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  CONTACTS_IMPORT_ACCEPT,
  CONTACTS_IMPORT_MAX_BYTES,
  canImportContacts,
  contactsImportFileProblem,
  contactsImportHref,
  contactsUploadErrorMessage,
} from './contacts-import-entry';
import { canWith } from '@/hooks/use-permissions';
import { isRouteAllowed, DATA_IMPORT_ROUTE_MODULES } from '@/router/route-permission-guard';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const row = (route: string, flags: { canRead?: boolean; canWrite?: boolean }) => ({
  module: { route, name: route },
  canRead: !!flags.canRead,
  canWrite: !!flags.canWrite,
});
const canFor = (roleModules: ReturnType<typeof row>[]) => (module: string, action: 'read' | 'write') =>
  canWith(roleModules, module, action);

// Fixtures mirror the API guard spec: grants on the child, on the parent,
// an explicit child deny under a parent grant, and an Admin role that has
// no data-import rows at all.
const CONTACTS_IMPORTER = canFor([row('data-import/contacts', { canRead: true, canWrite: true }), row('contacts', { canRead: true })]);
const PARENT_IMPORTER = canFor([row('data-import', { canRead: true, canWrite: true })]);
const CHILD_DENIED = canFor([
  row('data-import', { canRead: true, canWrite: true }),
  row('data-import/contacts', { canRead: false, canWrite: false }),
]);
const ADMIN_WITHOUT_GRANT = canFor([row('admin', { canRead: true, canWrite: true }), row('partners', { canRead: true, canWrite: true })]);

describe('one permission rule for every entry point, same as the API guard', () => {
  it('write on data-import/contacts, or on the parent data-import row, may import', () => {
    expect(canImportContacts(CONTACTS_IMPORTER)).toBe(true);
    expect(canImportContacts(PARENT_IMPORTER)).toBe(true);
  });

  it('an explicit deny on the child wins over the parent (API checks most specific first)', () => {
    expect(canImportContacts(CHILD_DENIED)).toBe(false);
  });

  it('no Admin bypass: an Admin without the grant does not get the button (API: NO_ADMIN_BYPASS)', () => {
    expect(canImportContacts(ADMIN_WITHOUT_GRANT)).toBe(false);
  });

  it('every entry page uses the shared rule and the shared link, never `isAdmin ||`', () => {
    const contacts = read('features/partners/contacts-page.tsx');
    const partners = read('features/partners/partners-page.tsx');
    const team = read('features/projects/project-detail/team-tab.tsx');
    expect(contacts).toMatch(/canImportContacts\(can\)/);
    expect(contacts).toMatch(/navigate\(contactsImportHref\(\)\)/);
    expect(partners).toMatch(/canImportContacts\(can\)/);
    expect(partners).toMatch(/navigate\(contactsImportHref\(\)\)/);
    expect(team).toMatch(/canImportContactsFor\(canPerm\)/);
    for (const src of [contacts, partners, team]) {
      expect(src).not.toMatch(/isAdmin\s*\|\|\s*\w+\(\s*'data-import/);
      expect(src).not.toMatch(/'\/admin\/data-import\?target=contacts'/);
    }
  });

  it('the Organizations (BP admin) entry is labelled "Import contacts", like the Contacts page', () => {
    const partners = read('features/partners/partners-page.tsx');
    expect(partners).toMatch(/Import contacts\s*<\/button>/);
    expect(partners).not.toMatch(/Import Excel \(wizard\)/);
  });
});

describe('both entry points open the same wizard', () => {
  it('the deep link targets the Data Import page with the contacts branch preselected', () => {
    expect(contactsImportHref()).toBe('/admin/data-import?target=contacts');
    expect(contactsImportHref(42)).toBe('/admin/data-import?target=contacts&projectId=42');
  });

  it('the route exists and renders DataImportPage, which mounts ContactsImportWizard for target=contacts', () => {
    const router = read('router/app-router.tsx');
    expect(router).toMatch(/<Route path="data-import" element={<L><DataImportPage \/><\/L>} \/>/);
    const page = read('features/data-import/data-import-page.tsx');
    expect(page).toMatch(/urlTarget === 'contacts'/);
    expect(page).toMatch(/<ContactsImportWizard/);
    // The Team tab mounts the very same component in a modal.
    expect(read('features/projects/project-detail/team-tab.tsx')).toMatch(/<ContactsImportWizard/);
  });

  it('the old bp-import-wizard is gone from the web source', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(name) && !name.endsWith('.spec.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/bp-import-wizard|BpImportWizard|bpImportWizard/.test(text) || /bp-import-wizard/.test(name)) offenders.push(full);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('no dead button: a contacts importer can open the page', () => {
  it('a role with only "Import Contacts" reaches /admin/data-import (was bounced to /)', () => {
    expect(isRouteAllowed('/admin/data-import', CONTACTS_IMPORTER, false)).toBe(true);
    expect(DATA_IMPORT_ROUTE_MODULES.split('|')).toContain('data-import/contacts');
  });

  it('but not the rest of Admin, nor the history page (API: data-import:read on the parent)', () => {
    expect(isRouteAllowed('/admin/roles', CONTACTS_IMPORTER, false)).toBe(false);
    expect(isRouteAllowed('/admin', CONTACTS_IMPORTER, false)).toBe(false);
    expect(isRouteAllowed('/admin/data-import/history', CONTACTS_IMPORTER, false)).toBe(false);
    expect(isRouteAllowed('/admin/data-import/history', PARENT_IMPORTER, false)).toBe(true);
  });

  it('a role with no import grant still cannot open it', () => {
    expect(isRouteAllowed('/admin/data-import', canFor([row('contacts', { canRead: true })]), false)).toBe(false);
  });
});

describe('the file is checked before upload', () => {
  it('accepts every format the server reads, by extension, case-insensitively', () => {
    for (const name of ['a.xlsx', 'b.XLS', 'c.csv', 'd.ods', 'e.docx', 'f.doc', 'g.odt', 'h.PDF']) {
      expect(contactsImportFileProblem({ name, size: 1000 })).toBeNull();
    }
    for (const ext of ['.xlsx', '.xls', '.csv', '.docx', '.doc', '.pdf', '.ods', '.odt']) {
      expect(CONTACTS_IMPORT_ACCEPT.split(',')).toContain(ext);
    }
  });

  it('refuses an unsupported type, an empty file and an oversized file, in words', () => {
    expect(contactsImportFileProblem({ name: 'photo.jpg', size: 10 })).toMatch(/not a supported file type/);
    expect(contactsImportFileProblem({ name: 'noext', size: 10 })).toMatch(/not a supported file type/);
    expect(contactsImportFileProblem({ name: 'empty.csv', size: 0 })).toMatch(/empty/);
    expect(contactsImportFileProblem({ name: 'big.pdf', size: CONTACTS_IMPORT_MAX_BYTES + 1 })).toMatch(/limit is 25 MB/);
    expect(contactsImportFileProblem({ name: 'edge.pdf', size: CONTACTS_IMPORT_MAX_BYTES })).toBeNull();
  });

  it('a failed upload is explained (permission, size, timeout, network)', () => {
    expect(contactsUploadErrorMessage(403)).toMatch(/permission to import contacts/);
    expect(contactsUploadErrorMessage(413)).toMatch(/too large/);
    expect(contactsUploadErrorMessage(504)).toMatch(/too long/);
    expect(contactsUploadErrorMessage(undefined)).toMatch(/Could not reach the server/);
    expect(contactsUploadErrorMessage(500, 'Internal server error')).toMatch(/Internal server error/);
  });

  it('user-visible wording has no long dashes', () => {
    const texts = [
      contactsImportFileProblem({ name: 'x.jpg', size: 1 }),
      contactsImportFileProblem({ name: 'x.pdf', size: CONTACTS_IMPORT_MAX_BYTES + 1 }),
      contactsUploadErrorMessage(403),
      contactsUploadErrorMessage(413),
      contactsUploadErrorMessage(undefined),
    ];
    for (const t of texts) expect(t).not.toMatch(/[–—]/);
  });
});
