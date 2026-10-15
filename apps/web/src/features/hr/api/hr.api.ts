import client from '@/api/client';

/**
 * HR Phase A4 (2026-10-15) — thin wrappers around the 7 /hr/*
 * endpoints. The HrEmployee + HrEligibility types are inferred from
 * the response shape so a schema change surfaces at compile time.
 */

export type EmploymentType = 'GLOBAL' | 'HOURLY';
export type BucketBehavior = 'A' | 'B' | 'C';
export type AbsenceUnit = 'DAY' | 'HOUR';
export type BucketCreditMode = 'REPORTED' | 'AUTO';

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

/** API response envelope — matches the project's { data } wrapper. */
function unwrap<T>(data: any): T {
  return (data?.data ?? data) as T;
}

export const hrApi = {
  listBuckets: (opts: { behavior?: BucketBehavior; activeOnly?: boolean } = {}) =>
    client
      .get('/hr/buckets', {
        params: {
          ...(opts.behavior ? { behavior: opts.behavior } : {}),
          ...(opts.activeOnly !== undefined ? { activeOnly: String(opts.activeOnly) } : {}),
        },
      })
      .then((r) => unwrap<SpecialHourBucketLite[]>(r.data)),

  listEmployees: () =>
    client.get('/hr/employees').then((r) => unwrap<HrEmployeeListRow[]>(r.data)),

  getEmployee: (id: number) =>
    client.get(`/hr/employees/${id}`).then((r) => unwrap<HrEmployeeDetail>(r.data)),

  updateEmployee: (id: number, payload: UpdateHrEmployeePayload) =>
    client.patch(`/hr/employees/${id}`, payload).then((r) => unwrap<HrEmployeeDetail>(r.data)),

  listEligibilities: (userId: number) =>
    client.get(`/hr/employees/${userId}/eligibilities`).then((r) => unwrap<HrEligibility[]>(r.data)),

  createEligibility: (userId: number, payload: CreateEligibilityPayload) =>
    client.post(`/hr/employees/${userId}/eligibilities`, payload).then((r) => unwrap<CreateEligibilityResponse>(r.data)),

  updateEligibility: (userId: number, eligibilityId: number, payload: UpdateEligibilityPayload) =>
    client.patch(`/hr/employees/${userId}/eligibilities/${eligibilityId}`, payload).then((r) => unwrap<HrEligibility>(r.data)),

  deactivateEligibility: (userId: number, eligibilityId: number) =>
    client.delete(`/hr/employees/${userId}/eligibilities/${eligibilityId}`).then((r) => unwrap<{ ok: true }>(r.data)),
};
