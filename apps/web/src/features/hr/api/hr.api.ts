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
export interface HrSettings {
  id: number;
  shortDayHoursHolidayEve: number;
  shortDayHoursCholHamoed: number;
  minHoursPerDay: number;
  updatedAt: string;
}
export interface UpdateHrSettingsPayload {
  shortDayHoursHolidayEve?: number;
  shortDayHoursCholHamoed?: number;
  minHoursPerDay?: number;
}

// CalendarDay ─────────────────────────────────────────────────────────
export interface HrCalendarDay {
  id: number;
  date: string;
  name: string;
  type: Exclude<CalendarDayType, 'REGULAR'>;
  halfDayUntil: string | null;
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
  halfDayUntil?: string | null;
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

  // Calendar days
  listCalendarDays: (year: number) =>
    client.get('/hr/calendar-days', { params: { year } }).then((r) => unwrap<HrCalendarDay[]>(r.data)),

  createCalendarDay: (payload: CreateHrCalendarDayPayload) =>
    client.post('/hr/calendar-days', payload).then((r) => unwrap<HrCalendarDay>(r.data)),

  updateCalendarDay: (id: number, payload: UpdateHrCalendarDayPayload) =>
    client.patch(`/hr/calendar-days/${id}`, payload).then((r) => unwrap<HrCalendarDay>(r.data)),

  deleteCalendarDay: (id: number) =>
    client.delete(`/hr/calendar-days/${id}`).then((r) => unwrap<{ ok: true; id: number }>(r.data)),

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
};
