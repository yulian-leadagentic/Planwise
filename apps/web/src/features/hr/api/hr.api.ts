import client from '@/api/client';

/**
 * HR Phase A4 + B4 (2026-10-15) — thin wrappers around the /hr/*
 * endpoints. Types inferred from the response shape so a schema
 * change surfaces at compile time.
 */

export type EmploymentType = 'GLOBAL' | 'HOURLY';
export type BucketBehavior = 'A' | 'B' | 'C';
export type AbsenceUnit = 'DAY' | 'HOUR';
export type BucketCreditMode = 'REPORTED' | 'AUTO';
export type CalendarDayType = 'REGULAR' | 'HOLIDAY' | 'HOLIDAY_EVE' | 'CHOL_HAMOED' | 'REST';
export type CalendarDayAppliesTo = 'all' | 'employees_only' | 'partners_only';

export interface SpecialHourBucketLite {
  id: number;
  code: string;
  nameHe: string;
  behavior: BucketBehavior;
  unit: AbsenceUnit;
  requiresDocument: boolean;
  dailyAmount: number | null;
  maxPerYear: number | null;
  minDailyStandard: number | null;
  defaultCreditMode: BucketCreditMode;
  active: boolean;
}

export interface SpecialHourBucket extends SpecialHourBucketLite {
  sortOrder: number;
  isSystem: boolean;
  createdAt: string;
}

/**
 * HR §9.1 (2026-10-16) — minimal shape returned by the caller-scoped
 * `/hr/me/pickable-buckets` endpoint. Deliberately narrower than
 * `SpecialHourBucket`: no `isSystem`, no `active` (both implicit from
 * the filter), no eligibility metadata. Only what the picker renders.
 */
export interface PickableBucket {
  id: number;
  code: string;
  nameHe: string;
  behavior: BucketBehavior;
  unit: AbsenceUnit;
  requiresDocument: boolean;
  dailyAmount: number | null;
  maxPerYear: number | null;
  minDailyStandard: number | null;
  defaultCreditMode: BucketCreditMode;
  sortOrder: number;
}

/**
 * HR F5 (2026-10-19) — unified time-category catalog entry. One flat
 * list that combines AbsenceType rows (kind=ABSENCE) with the A/C
 * SpecialHourBucket rows (kind=WORK_NON_PROJECT / QUOTA). The `kind`
 * discriminator is DERIVED on the server from existing data — no DB
 * migration. ENTITLEMENT (B) buckets are intentionally NOT included:
 * the engine auto-credits those; they are never user-reported through
 * this picker.
 *
 * `absenceTypeId` is set only when kind=ABSENCE; `bucketId` is set only
 * when kind=WORK_NON_PROJECT or QUOTA. The two never overlap — the FE
 * uses the `kind` to pick which id to send on save and which endpoint
 * to call.
 */
export type TimeCategoryKind = 'ABSENCE' | 'WORK_NON_PROJECT' | 'QUOTA';

export interface TimeCategory {
  kind: TimeCategoryKind;
  absenceTypeId?: number;
  bucketId?: number;
  code: string;
  nameHe: string;
  unit: AbsenceUnit;
  requiresDocument: boolean;
  maxPerYear: number | null;
  active: true;
  sortOrder: number;
}

export interface HrEligibility {
  id: number;
  userId: number;
  bucketId: number;
  dailyAmount: number;
  startDate: string;
  endDate: string;
  creditMode: BucketCreditMode | null;
  documentFileId: number | null;
  active: boolean;
  createdById: number;
  createdAt: string;
  bucket: SpecialHourBucketLite | null;
}

export interface HrEmployeeListRow {
  id: number;
  firstName: string;
  lastName: string;
  firstNameHe: string | null;
  lastNameHe: string | null;
  email: string;
  dailyStandardHours: number | null;
  employmentType: EmploymentType | null;
  accountingEmployeeNumber: string | null;
  employmentDate: string | null;
  employmentEndDate: string | null;
  isActive: boolean;
  orgUnit: { id: number; name: string } | null;
}

export interface HrEmployeeDetail extends HrEmployeeListRow {
  bucketEligibilities: HrEligibility[];
}

export interface UpdateHrEmployeePayload {
  employmentType?: EmploymentType | null;
  accountingEmployeeNumber?: string | null;
  dailyStandardHours?: number | null;
  employmentDate?: string | null;
  employmentEndDate?: string | null;
}

export interface CreateEligibilityPayload {
  bucketId: number;
  dailyAmount?: number;
  startDate?: string;
  endDate?: string;
  creditMode?: BucketCreditMode;
  documentFileId?: number;
}

export interface UpdateEligibilityPayload {
  dailyAmount?: number;
  startDate?: string;
  endDate?: string;
  creditMode?: BucketCreditMode | null;
  documentFileId?: number | null;
  active?: boolean;
}

export interface CreateEligibilityResponse {
  eligibility: HrEligibility;
  warnings: string[];
}

// HR Settings ─────────────────────────────────────────────────────────
// HR Wave 2 G2 (2026-10-19) — shortDayHoursHolidayEve +
// shortDayHoursCholHamoed removed. Per-day working hours now live on
// CalendarDay.workingHours; the two globals were dropped from
// hr_settings by `20261019010000_hr_working_hours/migration.sql`.
export interface HrSettings {
  id: number;
  minHoursPerDay: number;
  updatedAt: string;
}
export interface UpdateHrSettingsPayload {
  minHoursPerDay?: number;
}

// CalendarDay ─────────────────────────────────────────────────────────
export interface HrCalendarDay {
  id: number;
  date: string;
  name: string;
  type: Exclude<CalendarDayType, 'REGULAR'>;
  /** @deprecated G2 (2026-10-19) — use `workingHours`. Kept on the type
   *  for one release so stale caches don't crash on parse. */
  halfDayUntil: string | null;
  /** HR Wave 2 G2 (2026-10-19) — per-day working hours. Non-null
   *  post-backfill for every row the HR module writes
   *  (HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED / REST). */
  workingHours: number;
  appliesTo: CalendarDayAppliesTo;
  isRecurring: boolean;
  notes: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  creator?: { id: number; firstName: string; lastName: string };
}
export interface CreateHrCalendarDayPayload {
  date: string;
  type: Exclude<CalendarDayType, 'REGULAR'>;
  name: string;
  appliesTo?: CalendarDayAppliesTo;
  /** @deprecated G2 (2026-10-19) — use `workingHours`. */
  halfDayUntil?: string | null;
  /** HR Wave 2 G2 (2026-10-19) — per-day working hours; null / omitted
   *  = fall back to type default on the server. */
  workingHours?: number | null;
  notes?: string | null;
  isRecurring?: boolean;
}
export type UpdateHrCalendarDayPayload = Partial<CreateHrCalendarDayPayload>;

// AbsenceType ─────────────────────────────────────────────────────────
export interface AbsenceType {
  id: number;
  code: string;
  nameHe: string;
  unit: AbsenceUnit;
  requiresDocument: boolean;
  deductsFromSick: boolean;
  maxPerYear: number | null;
  halfDay: boolean;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
  createdAt: string;
}
export interface CreateAbsenceTypePayload {
  code: string;
  nameHe: string;
  unit: AbsenceUnit;
  requiresDocument?: boolean;
  deductsFromSick?: boolean;
  maxPerYear?: number | null;
  halfDay?: boolean;
  active?: boolean;
  sortOrder?: number;
}
export type UpdateAbsenceTypePayload = Partial<CreateAbsenceTypePayload>;

// AbsenceRecord ───────────────────────────────────────────────────────
export interface AbsenceRecord {
  id: number;
  userId: number;
  absenceTypeId: number;
  dateFrom: string;
  dateTo: string;
  amount: number;
  documentFileId: number | null;
  note: string | null;
  createdById: number;
  createdAt: string;
  absenceType: {
    id: number;
    code: string;
    nameHe: string;
    unit: AbsenceUnit;
    requiresDocument: boolean;
    halfDay: boolean;
  };
  createdBy?: { id: number; firstName: string; lastName: string };
  document?: {
    id: number;
    fileName: string;
    fileUrl: string;
    mimeType: string | null;
    fileSize: number | null;
  } | null;
}
export interface CreateAbsencePayload {
  absenceTypeId: number;
  dateFrom: string;
  dateTo?: string;
  amount: number;
  documentFileId?: number | null;
  note?: string;
}
export type UpdateAbsencePayload = Partial<CreateAbsencePayload>;

// EmployeeAttachment ──────────────────────────────────────────────────
export interface EmployeeAttachment {
  id: number;
  userId: number;
  fileName: string;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  uploadedBy: number;
  createdAt: string;
  uploader?: { id: number; firstName: string; lastName: string };
}
export interface UploadAttachmentResponse {
  id: number;
  url: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
}

// ─── MonthlyAttendance (Phase C) ──────────────────────────────────────
export type MonthlyStatus = 'OPEN' | 'APPROVED' | 'LOCKED' | 'DRAFT';

export interface MonthlyAttendanceRow {
  id: number;
  userId: number;
  year: number;
  month: number;
  monthlyStandard: number;
  actualHours: number;
  weightedHours: number;
  deviation: number;
  sickDays: number;
  vacationDays: number;
  daysOffice: number;
  daysHome: number;
  daysSite: number;
  status: MonthlyStatus;
  approvedById: number | null;
  approvedAt: string | null;
  computedAt: string | null;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    firstNameHe: string | null;
    lastNameHe: string | null;
    accountingEmployeeNumber: string | null;
  };
  approvedBy?: { id: number; firstName: string; lastName: string } | null;
}

export interface DailyBreakdownRow {
  date: string;
  dayType: CalendarDayType;
  dayStandard: number;
  actualHours: number;
  absenceCredit: number;
  sickCredit: number;
  vacationCredit: number;
  locationBucket: 'office' | 'home' | 'site' | null;
  autoDeduction: number;
}

export interface MonthlyUserDetail {
  row: MonthlyAttendanceRow;
  dailyBreakdown: DailyBreakdownRow[];
}

export interface RecomputeResponse {
  computed: MonthlyAttendanceRow[];
  skipped: Array<{ userId: number; reason: string }>;
}

export interface CBucketUsage {
  bucketId: number | null;
  code: string | null;
  nameHe: string | null;
  unit: AbsenceUnit | null;
  used: number;
  maxPerYear: number | null;
}

export interface MyMonthlySummary {
  row: MonthlyAttendanceRow;
  dailyBreakdown: DailyBreakdownRow[];
  monthlyAbsences: AbsenceRecord[];
  cBucketUsage: CBucketUsage[];
}

// ─── Consolidated accounting report (Phase D) ─────────────────────────
//
// D2 §13 (2026-10-18) — the report is on-the-fly and ungated. Empty
// scope / no data returns `{ year, month, employees: [] }`; status is
// surfaced as a per-employee badge rather than a blocker. Scope is now
// a plain `userIds?: number[]` (omit → all active).

export interface ReportPayloadDay {
  date: string; // yyyy-MM-dd
  weekday: string; // Hebrew: ראשון/שני/.../שבת
  startTime: string | null;
  endTime: string | null;
  totalHours: number;
  dayType: string;
}

export interface ReportPayloadEmployee {
  header: {
    userId: number;
    firstName: string;
    lastName: string;
    firstNameHe: string | null;
    lastNameHe: string | null;
    accountingEmployeeNumber: string | null;
    monthlyStandard: number;
    actualHours: number;
    weightedHours: number;
    deviation: number;
    sickDays: number;
    vacationDays: number;
    status: MonthlyStatus;
    error?: string;
  };
  rows: ReportPayloadDay[];
}

export interface ReportPayload {
  year: number;
  month: number;
  employees: ReportPayloadEmployee[];
}

// Bucket admin CRUD ───────────────────────────────────────────────────
export interface CreateBucketPayload {
  code: string;
  nameHe: string;
  behavior: BucketBehavior;
  unit: AbsenceUnit;
  requiresDocument?: boolean;
  dailyAmount?: number | null;
  maxPerYear?: number | null;
  minDailyStandard?: number | null;
  defaultCreditMode?: BucketCreditMode;
  active?: boolean;
  sortOrder?: number;
}
export type UpdateBucketPayload = Partial<CreateBucketPayload>;

/** API response envelope — matches the project's { data } wrapper. */
function unwrap<T>(data: any): T {
  return (data?.data ?? data) as T;
}

export const hrApi = {
  /**
   * HR §9.1 (2026-10-16) — the picker's data source. Any authenticated
   * user can call this; the server returns A + C active + B only when
   * the caller holds an active REPORTED eligibility covering today.
   * The admin catalog (`listBuckets` below) stays `hr:read` for the
   * HR module surfaces (`/hr/settings`, employee drawer).
   */
  listMyPickableBuckets: () =>
    client.get('/hr/me/pickable-buckets').then((r) => unwrap<PickableBucket[]>(r.data)),

  // F5 (2026-10-19) — unified time-category catalog. Flat list of
  // AbsenceType rows + A/C SpecialHourBucket rows, tagged with a `kind`
  // discriminator. QUOTA (C) buckets are only returned when the caller
  // holds an active eligibility covering today. See
  // HrService.listTimeCategoriesForCaller.
  listTimeCategories: () =>
    client.get('/hr/time-categories').then((r) => unwrap<TimeCategory[]>(r.data)),

  // ─── Self-service (caller acts on their own HR records) ──────────────
  // G2.2 (2026-10-20) — the HR-manager endpoints under /hr/employees/:id
  // run `assertEmployee` which 404s whenever the caller's userType is not
  // the literal `'employee'` (admins, partners, …). These `/hr/me/*`
  // paths bypass that gate and always act for the authenticated caller.
  createMyAbsence: (payload: CreateAbsencePayload) =>
    client.post('/hr/me/absences', payload).then((r) => unwrap<AbsenceRecord>(r.data)),

  // G2.3 (2026-10-20) — self-service list + delete for absence records.
  // Returns ONLY the caller's own rows (server pins the user id), so the
  // weekly timesheet can render absence badges without needing an
  // `userType === 'employee'` check or the hr:write gate.
  listMyAbsences: (opts: { year?: number; typeId?: number } = {}) =>
    client
      .get('/hr/me/absences', {
        params: {
          ...(opts.year != null ? { year: opts.year } : {}),
          ...(opts.typeId != null ? { typeId: opts.typeId } : {}),
        },
      })
      .then((r) => unwrap<AbsenceRecord[]>(r.data)),

  // W2 (2026-10-20) — self-service PATCH for an absence record. Pairs
  // with the Timeoff edit-mode form (click a Timesheet absence badge
  // to open it for edit).
  updateMyAbsence: (recordId: number, payload: UpdateAbsencePayload) =>
    client
      .patch(`/hr/me/absences/${recordId}`, payload)
      .then((r) => unwrap<AbsenceRecord>(r.data)),

  deleteMyAbsence: (recordId: number) =>
    client
      .delete(`/hr/me/absences/${recordId}`)
      .then((r) => unwrap<{ ok: true; id: number }>(r.data)),

  uploadMyAttachment: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client
      .post('/hr/me/attachments', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => unwrap<UploadAttachmentResponse>(r.data));
  },

  // Buckets
  listBuckets: (opts: { behavior?: BucketBehavior; activeOnly?: boolean } = {}) =>
    client
      .get('/hr/buckets', {
        params: {
          ...(opts.behavior ? { behavior: opts.behavior } : {}),
          ...(opts.activeOnly !== undefined ? { activeOnly: String(opts.activeOnly) } : {}),
        },
      })
      .then((r) => unwrap<SpecialHourBucket[]>(r.data)),

  createBucket: (payload: CreateBucketPayload) =>
    client.post('/hr/buckets', payload).then((r) => unwrap<SpecialHourBucket>(r.data)),

  updateBucket: (id: number, payload: UpdateBucketPayload) =>
    client.patch(`/hr/buckets/${id}`, payload).then((r) => unwrap<SpecialHourBucket>(r.data)),

  deleteBucket: (id: number) =>
    client.delete(`/hr/buckets/${id}`).then((r) => unwrap<{ ok: true; id: number }>(r.data)),

  // Employees
  listEmployees: () =>
    client.get('/hr/employees').then((r) => unwrap<HrEmployeeListRow[]>(r.data)),

  getEmployee: (id: number) =>
    client.get(`/hr/employees/${id}`).then((r) => unwrap<HrEmployeeDetail>(r.data)),

  updateEmployee: (id: number, payload: UpdateHrEmployeePayload) =>
    client.patch(`/hr/employees/${id}`, payload).then((r) => unwrap<HrEmployeeDetail>(r.data)),

  // Eligibilities
  listEligibilities: (userId: number) =>
    client.get(`/hr/employees/${userId}/eligibilities`).then((r) => unwrap<HrEligibility[]>(r.data)),

  createEligibility: (userId: number, payload: CreateEligibilityPayload) =>
    client.post(`/hr/employees/${userId}/eligibilities`, payload).then((r) => unwrap<CreateEligibilityResponse>(r.data)),

  updateEligibility: (userId: number, eligibilityId: number, payload: UpdateEligibilityPayload) =>
    client.patch(`/hr/employees/${userId}/eligibilities/${eligibilityId}`, payload).then((r) => unwrap<HrEligibility>(r.data)),

  deactivateEligibility: (userId: number, eligibilityId: number) =>
    client.delete(`/hr/employees/${userId}/eligibilities/${eligibilityId}`).then((r) => unwrap<{ ok: true }>(r.data)),

  // Settings
  getSettings: () =>
    client.get('/hr/settings').then((r) => unwrap<HrSettings>(r.data)),

  updateSettings: (payload: UpdateHrSettingsPayload) =>
    client.patch('/hr/settings', payload).then((r) => unwrap<HrSettings>(r.data)),

  // §15 R2 (2026-10-18) · F2 (2026-10-19) — Calendar CRUD endpoints
  // stay OUT of this surface. Calendar days are now managed via the
  // HR sub-tab at /hr/calendar (features/hr/calendar-page.tsx on the
  // FE); the BE path is still `/calendar/*` and hasn't moved. Types
  // `HrCalendarDay` / `CreateHrCalendarDayPayload` /
  // `UpdateHrCalendarDayPayload` stay exported because the
  // CalendarDayType shape is still needed by MonthlyAttendance
  // breakdown rows (`DailyBreakdownRow.dayType`).

  // Absence types
  listAbsenceTypes: (opts: { activeOnly?: boolean } = {}) =>
    client
      .get('/hr/absence-types', {
        params: opts.activeOnly ? { activeOnly: 'true' } : {},
      })
      .then((r) => unwrap<AbsenceType[]>(r.data)),

  createAbsenceType: (payload: CreateAbsenceTypePayload) =>
    client.post('/hr/absence-types', payload).then((r) => unwrap<AbsenceType>(r.data)),

  updateAbsenceType: (id: number, payload: UpdateAbsenceTypePayload) =>
    client.patch(`/hr/absence-types/${id}`, payload).then((r) => unwrap<AbsenceType>(r.data)),

  deleteAbsenceType: (id: number) =>
    client.delete(`/hr/absence-types/${id}`).then((r) => unwrap<{ ok: true; id: number }>(r.data)),

  // Absences per employee
  listAbsences: (userId: number, opts: { year?: number; typeId?: number } = {}) =>
    client
      .get(`/hr/employees/${userId}/absences`, {
        params: {
          ...(opts.year != null ? { year: opts.year } : {}),
          ...(opts.typeId != null ? { typeId: opts.typeId } : {}),
        },
      })
      .then((r) => unwrap<AbsenceRecord[]>(r.data)),

  createAbsence: (userId: number, payload: CreateAbsencePayload) =>
    client.post(`/hr/employees/${userId}/absences`, payload).then((r) => unwrap<AbsenceRecord>(r.data)),

  updateAbsence: (userId: number, recordId: number, payload: UpdateAbsencePayload) =>
    client.patch(`/hr/employees/${userId}/absences/${recordId}`, payload).then((r) => unwrap<AbsenceRecord>(r.data)),

  deleteAbsence: (userId: number, recordId: number) =>
    client.delete(`/hr/employees/${userId}/absences/${recordId}`).then((r) => unwrap<{ ok: true; id: number }>(r.data)),

  // Attachments per employee
  listAttachments: (userId: number) =>
    client.get(`/hr/employees/${userId}/attachments`).then((r) => unwrap<EmployeeAttachment[]>(r.data)),

  uploadAttachment: (userId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return client
      .post(`/hr/employees/${userId}/attachments`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => unwrap<UploadAttachmentResponse>(r.data));
  },

  deleteAttachment: (userId: number, attachmentId: number) =>
    client
      .delete(`/hr/employees/${userId}/attachments/${attachmentId}`)
      .then((r) => unwrap<{ ok: true; id: number }>(r.data)),

  /**
   * Open an HR attachment in a new tab (2026-10-21).
   *
   * The stored `fileUrl` on an attachment is a relative path inside the
   * API's upload root (e.g. `/hr/<uuid>.txt`) — the app has no static
   * mount for it, so handing that path to a plain `<a href>` 404s on
   * the SPA router. Instead we fetch the file through the authenticated
   * axios client (so JWT + refresh handling comes along for free), wrap
   * the bytes in a Blob with the server's Content-Type, and open the
   * resulting object URL in a new tab. The browser then renders inline
   * for pdf/txt/images and offers a save dialog otherwise.
   */
  openAttachment: async (attachmentId: number): Promise<void> => {
    const res = await client.get(`/hr/attachments/${attachmentId}/download`, {
      responseType: 'blob',
    });
    const contentType =
      (res.headers['content-type'] as string | undefined) ||
      'application/octet-stream';
    const blob = new Blob([res.data], { type: contentType });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      // Pop-up blocker ate the new tab — fall back to same-tab nav so
      // the click never silently no-ops.
      window.location.href = url;
    }
    // Revoke after the new tab has had time to pull the bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  // ─── Monthly attendance (Phase C) ──────────────────────────────────
  recomputeMonthly: (payload: { year: number; month: number; userIds?: number[] }) =>
    client.post('/hr/monthly/recompute', payload).then((r) => unwrap<RecomputeResponse>(r.data)),

  listMonthly: (year: number, month: number) =>
    client
      .get('/hr/monthly', { params: { year, month } })
      .then((r) => unwrap<MonthlyAttendanceRow[]>(r.data)),

  getMonthlyForUser: (userId: number, year: number, month: number) =>
    client
      .get(`/hr/monthly/${userId}`, { params: { year, month } })
      .then((r) => unwrap<MonthlyUserDetail>(r.data)),

  approveMonthly: (userId: number, year: number, month: number) =>
    client
      .post(`/hr/monthly/${userId}/approve`, { year, month })
      .then((r) => unwrap<MonthlyAttendanceRow>(r.data)),

  reopenMonthly: (userId: number, year: number, month: number) =>
    client
      .post(`/hr/monthly/${userId}/reopen`, { year, month })
      .then((r) => unwrap<MonthlyAttendanceRow>(r.data)),

  /**
   * Caller-scoped — no `hr:*` guard. Mounted under `/time-entries/*`
   * on the API side (keeps all per-user time surfaces under one
   * controller); the FE calls it from the Time tab.
   */
  getMyMonthlySummary: (year: number, month: number) =>
    client
      .get('/time-entries/my-monthly-summary', { params: { year, month } })
      .then((r) => unwrap<MyMonthlySummary>(r.data)),

  // ─── Consolidated accounting report (Phase D) ────────────────────
  //
  // D2 §13 (2026-10-18) — GET-based + on-the-fly. `userIds` is a CSV
  // query param when scoped; omit it to let the server resolve "all
  // active". Both the data endpoint and the export endpoint accept the
  // same shape and never 500 on empty scope.
  fetchConsolidatedReport: (
    year: number,
    month: number,
    userIds?: number[],
  ) =>
    client
      .get('/hr/reports/consolidated', {
        params: {
          year,
          month,
          userIds: userIds?.length ? userIds.join(',') : undefined,
        },
      })
      .then((r) => unwrap<ReportPayload>(r.data)),

  /**
   * Direct-download helper for the XLSX/PDF export. Returns the Blob
   * so the caller can trigger an <a download> click. No APPROVED
   * gate — fires straight through regardless of per-employee status.
   */
  exportConsolidated: (
    year: number,
    month: number,
    format: 'xlsx' | 'pdf',
    userIds?: number[],
  ) =>
    client
      .get('/hr/reports/consolidated/export', {
        params: {
          year,
          month,
          format,
          userIds: userIds?.length ? userIds.join(',') : undefined,
        },
        responseType: 'blob',
      })
      .then((r) => r.data as Blob),

  /**
   * Lock a MonthlyAttendance row (status → LOCKED). Fired from the
   * consolidated report's per-employee lock button; irreversible via
   * the FE. Returns the updated row so the caller can patch state in
   * place.
   */
  lockMonthly: (userId: number, year: number, month: number) =>
    client
      .post(`/hr/monthly/${userId}/lock`, { year, month })
      .then((r) => unwrap<MonthlyAttendanceRow>(r.data)),
};
