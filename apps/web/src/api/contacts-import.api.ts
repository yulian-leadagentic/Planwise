/**
 * BM2 · Contacts import wizard — frontend client for the contacts
 * sub-mode of /data-import (see `apps/web/src/features/data-import/`).
 *
 * All endpoints live under `/data-import/contacts/*` per the methodology
 * in `docs/bm2/bp-import-methodology.md`; the shared /data-import
 * scaffolding (permission modules, job-history page) still applies.
 */
import client from './client';

// ─── Types mirrored from the API (contacts subsystem) ─────────────────

export type ContactField =
  | 'email'
  | 'mobile'
  | 'phone'
  | 'contact'
  | 'company'
  | 'discipline'
  | 'role'
  | 'address'
  | 'note';

/**
 * Column mapping shape.
 *
 * QA4 R2 IMP-8 (2026-09-29) — a target field may be fed by MORE THAN
 * ONE source column. When the value is a string, only that header
 * feeds the field (unchanged behaviour). When the value is a
 * `string[]`, every listed header is tokenised and the classifier
 * decides by content — used e.g. when the sheet has two columns both
 * describing Job Title, or when phone/mobile share a "contact info"
 * column. An empty array is treated as "not mapped".
 */
export type ContactsMapping = Partial<Record<ContactField, string | string[]>>;

export interface ExtractedSheet {
  name: string;
  rows: string[][];
}

export type TriageResult =
  | { kind: 'tabular'; reader: 'xlsx' | 'xls' | 'csv' | 'html-xlsx'; filename?: string; sheets: ExtractedSheet[] }
  | { kind: 'docx-tables'; reader: 'docx'; filename?: string; sheets: ExtractedSheet[] }
  | {
      kind: 'pdf';
      reader: 'pdf';
      filename?: string;
      confidence: number;
      pages: number;
      sheets: ExtractedSheet[];
    }
  | { kind: 'reject'; reason: string };

export type SheetVerdict = 'auto' | 'manual' | 'headerless' | 'non-contact';

export interface SheetGrade {
  sheetName: string;
  verdict: SheetVerdict;
  reason: string;
  headerRowIndex: number | null;
  headerCells: string[];
  mapping: Partial<Record<ContactField, number>>;
  confidence: number;
  totalCandidateRows: number;
  dataRowCount: number;
  headerMatchedFieldCount: number;
}

export interface UploadResponse {
  triage: TriageResult;
  grades: SheetGrade[];
}

export interface RowSynthesis {
  emailSplit?: boolean;
  phoneSplit?: boolean;
  companyFilled?: boolean;
  disciplineFilled?: boolean;
  emailSplitFailed?: boolean;
  phoneSplitFailed?: boolean;
}

export interface ResolvedRow {
  sourceRowIndex: number;
  values: Partial<Record<ContactField, string>>;
  raw: Record<string, string>;
  synthesis: RowSynthesis;
  extraEmails?: string[];
  extraPhones?: string[];
  errors: string[];
  /** QA4 IMP-4 — extracted office managers etc. attached to this row's org. */
  secondaryContacts?: SecondaryContact[];
}

/**
 * QA4 IMP-4 — a person the deterministic classifier assembled from
 * tokens in a non-name cell (usually the phone cell, e.g. "04-8311191
 * דפנה - חיפה" yielding name דפנה + city חיפה). Surfaces as its own
 * row in the Preview table with an "extracted" tag.
 */
export interface SecondaryContact {
  name: string;
  phone?: string;
  mobile?: string;
  email?: string;
  city?: string;
  title: string;
  sourceField: 'phone' | 'mobile' | 'email' | 'company' | 'note';
  confidence: number;
}

export type OrgAction = 'link' | 'create' | 'skip' | 'conflict';
export type ContactAction = 'link' | 'create' | 'skip';

export interface DedupSide {
  action: OrgAction | ContactAction;
  reason: string;
  matchedBpId?: number;
  matchedBpName?: string | null;
  matchReason?: 'domain' | 'name';
}

export interface DedupDecision {
  sourceRowIndex: number;
  values: Partial<Record<ContactField, string>>;
  domain: string | null;
  isPersonalDomain: boolean;
  meetsMinimumContract: boolean;
  contractError: string | null;
  org: DedupSide;
  contact: DedupSide;
  /** QA4 IMP-4 — mirrored from ResolvedRow so the preview table can
   * insert extracted contacts as their own rows. */
  secondaryContacts?: SecondaryContact[];
  /**
   * QA4 R2 IMP-9 — additional emails classified out of a multi-email
   * cell. Not shown as separate rows on the preview; used at commit
   * to populate the person's / org's additional-emails list.
   */
  extraEmails?: string[];
}

export interface PreviewSummary {
  totalRows: number;
  eligible: number;
  belowContract: number;
  orgsToCreate: number;
  orgsToLink: number;
  orgConflicts: number;
  orgsSkipped: number;
  contactsToCreate: number;
  contactsToLink: number;
  contactsSkipped: number;
  emailSplitRows: number;
  phoneSplitRows: number;
  companyFilledRows: number;
  disciplineFilledRows: number;
  emailSplitFailedRows: number;
  phoneSplitFailedRows: number;
}

export interface SheetPreview {
  sheetName: string;
  headerRowIndex: number;
  headerCells: string[];
  dataRowCount: number;
  mapping: ContactsMapping;
  resolvedRows: ResolvedRow[];
  decisions: DedupDecision[];
  summary: PreviewSummary;
}

export interface MappingPreset {
  id: number;
  name: string;
  kind: string;
  description: string | null;
  mapping: ContactsMapping;
  signature: { fields: ContactField[] };
  isSystem: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields the PM can override inline on the Preview table (QA4 IMP-2).
 * `officeManager` is not a canonical ContactField — it lives on
 * extracted secondary-contact rows (see QA4 IMP-4) and, when edited on
 * the primary row, carries an office-manager name the classifier pulled
 * from the phone cell.
 *
 * QA4 Round-2 IMP-6 (2026-09-29) added `role` — the person's Job Title
 * (aka professional role, e.g. Architect, Structural engineer). Editable
 * even for rows the mapping didn't auto-fill, so the PM can add the
 * missing title during load.
 */
export type OverrideField =
  | 'contact'
  | 'company'
  | 'phone'
  | 'mobile'
  | 'email'
  | 'discipline'
  | 'role'
  | 'officeManager';

export type RowOverrides = Partial<Record<OverrideField, string | null>>;

export interface RowDecision {
  sourceRowIndex: number;
  orgAction?: OrgAction;
  orgBpId?: number | null;
  contactAction?: ContactAction;
  contactBpId?: number | null;
  /** When splitting produced multiple emails, this is the one to persist. */
  chosenEmail?: string;
  /**
   * QA4 IMP-2 — per-field inline overrides from the Preview table.
   * When present, the backend prefers each override value over the
   * parsed value at commit time. `null` explicitly clears a parsed
   * value.
   */
  overrides?: RowOverrides;
}

export interface CommitSummary {
  importId: number;
  orgsCreated: number;
  orgsLinked: number;
  orgsSkipped: number;
  contactsCreated: number;
  contactsLinked: number;
  contactsSkipped: number;
  workerOfLinksCreated: number;
  projectAttached: number;
  belowContract: number;
  errors: number;
  perRow: Array<{
    sourceRowIndex: number;
    status: 'created' | 'linked' | 'skipped' | 'error';
    orgBpId: number | null;
    contactBpId: number | null;
    message?: string;
  }>;
}

// ─── API ──────────────────────────────────────────────────────────────

/**
 * Every endpoint below runs through the API's global ResponseInterceptor,
 * which wraps the handler's return value as `{ success: true, data: <payload> }`.
 * Axios then puts that envelope on `response.data`, so the actual payload is
 * at `response.data.data`. This helper unwraps defensively — if a caller
 * happens to hit an un-intercepted route it still gets the raw payload.
 *
 * The bug this fixes: `contacts-import` upload returned the wrapper as the
 * payload, so `data.triage` was undefined and the wizard crashed with
 * "Cannot read properties of undefined (reading 'kind')" on line 189.
 */
function unwrap<T>(res: { data: any }): T {
  return (res.data?.data ?? res.data) as T;
}

export const contactsImportApi = {
  /**
   * Stage 1 + Stage 2 — upload the file, receive triage + per-sheet
   * grade in one round-trip.
   */
  upload: async (file: File): Promise<UploadResponse> => {
    const form = new FormData();
    form.append('file', file);
    // The shared axios client's request interceptor detects FormData
    // bodies and removes the instance-default `Content-Type` so the
    // browser sets `multipart/form-data; boundary=<token>` itself.
    // See apps/web/src/api/client.ts request interceptor.
    const r = await client.post<UploadResponse>('/data-import/contacts/upload', form);
    return unwrap<UploadResponse>(r);
  },

  /**
   * Stage 5 — resolve one sheet + return dedup decisions per row. No writes.
   */
  preview: async (input: {
    sheet: ExtractedSheet;
    mapping: ContactsMapping;
    headerRowIndex?: number;
  }): Promise<SheetPreview> => {
    const r = await client.post<SheetPreview>('/data-import/contacts/preview', input);
    return unwrap<SheetPreview>(r);
  },

  /**
   * Stage 6 — commit. Ships in the Stage 6 wiring; endpoint may 404
   * until then.
   *
   * `attachToProjectId` (optional) attaches each committed person to
   * that project as a `project_partner_role`; `projectRoleId` (optional)
   * pins the ProjectRoleType. If `projectRoleId` is omitted the backend
   * falls back to a role type with code `contact` / `external_contact`
   * / `consultant`, else the person is created without a project attach.
   */
  commit: async (input: {
    sheet: ExtractedSheet;
    mapping: ContactsMapping;
    headerRowIndex?: number;
    decisions: RowDecision[];
    filename?: string;
    attachToProjectId?: number | null;
    projectRoleId?: number | null;
    notes?: string;
  }): Promise<CommitSummary> => {
    const r = await client.post<CommitSummary>('/data-import/contacts/commit', input);
    return unwrap<CommitSummary>(r);
  },

  // ─── Mapping presets (Stage 3) ─────────────────────────────────────

  listPresets: async (): Promise<MappingPreset[]> => {
    const r = await client.get<MappingPreset[]>('/data-import/contacts/mapping-presets');
    return unwrap<MappingPreset[]>(r);
  },

  savePreset: async (input: {
    id?: number;
    name: string;
    description?: string | null;
    mapping: ContactsMapping;
  }): Promise<MappingPreset> => {
    const r = await client.post<MappingPreset>('/data-import/contacts/mapping-presets', {
      kind: 'contacts',
      ...input,
    });
    return unwrap<MappingPreset>(r);
  },

  deletePreset: async (id: number): Promise<void> => {
    await client.delete(`/data-import/contacts/mapping-presets/${id}`);
  },
};

export const CONTACT_FIELD_LABELS: Record<ContactField, string> = {
  email: 'Email',
  mobile: 'Mobile',
  phone: 'Phone',
  contact: 'Contact name',
  company: 'Company',
  discipline: 'Discipline',
  role: 'Role / title',
  address: 'Address',
  note: 'Notes',
};

export const CONTACT_FIELDS: ContactField[] = [
  'contact',
  'company',
  'email',
  'mobile',
  'phone',
  'discipline',
  'role',
  'address',
  'note',
];
