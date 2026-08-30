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

export type ContactsMapping = Partial<Record<ContactField, string>>;

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

export interface RowDecision {
  sourceRowIndex: number;
  orgAction?: OrgAction;
  orgBpId?: number | null;
  contactAction?: ContactAction;
  contactBpId?: number | null;
  /** When splitting produced multiple emails, this is the one to persist. */
  chosenEmail?: string;
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

export const contactsImportApi = {
  /**
   * Stage 1 + Stage 2 — upload the file, receive triage + per-sheet
   * grade in one round-trip.
   */
  upload: async (file: File): Promise<UploadResponse> => {
    const form = new FormData();
    form.append('file', file);
    // Do NOT set 'Content-Type' manually — axios inspects the FormData body
    // and emits `multipart/form-data; boundary=…`. A manual header without a
    // boundary token yields an unparseable body on the server (multer can't
    // split the parts) — this was the F28 upload failure. (BM2 · commit 6.)
    const r = await client.post<UploadResponse>('/data-import/contacts/upload', form);
    return r.data;
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
    return r.data;
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
    return r.data;
  },

  // ─── Mapping presets (Stage 3) ─────────────────────────────────────

  listPresets: async (): Promise<MappingPreset[]> => {
    const r = await client.get<MappingPreset[]>('/data-import/contacts/mapping-presets');
    return r.data;
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
    return r.data;
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
