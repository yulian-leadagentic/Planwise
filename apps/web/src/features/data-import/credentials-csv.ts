import type { ImportedCredential } from '@/api/data-import.api';

/**
 * Permissions round 3 (2026-11-22) — CSV of the initial passwords a users
 * import created (the commit response is the only place they exist).
 *
 * RFC 4180 cells: always quoted, inner quotes doubled. A cell that starts
 * with = + - @ (or a tab / CR) gets a leading apostrophe so a spreadsheet
 * never evaluates it as a formula (CSV injection) — generated passwords
 * are alphanumeric, but names and e-mails come from the uploaded file.
 */
export function csvCell(value: string): string {
  const v = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function credentialsCsv(credentials: ImportedCredential[]): string {
  const header = ['Email', 'First Name', 'Last Name', 'Initial Password'].map(csvCell).join(',');
  const rows = credentials.map((c) => [c.email, c.firstName, c.lastName, c.password].map(csvCell).join(','));
  return [header, ...rows].join('\r\n');
}
