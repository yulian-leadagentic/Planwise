import { Injectable, Logger } from '@nestjs/common';
import { DataImportMode, DataImportTarget, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import ExcelJS from 'exceljs';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  CommitResult,
  EntityImporter,
  ValidatedRow,
  ValidationContext,
} from './importer.types';

/**
 * What the importer writes per row, after column validation +
 * lookups. The User entity expects normalized values (roleId not role
 * name) so we resolve them once here and store the result on
 * ValidatedRow.data.
 */
interface UserImportRow {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  roleId: number;
  userType: UserType;
  position?: string;
  department?: string;
  employeeCategory?: string;
  employmentDate?: Date;
  employmentEndDate?: Date;
  seniorityLevelId?: number;
  dailyStandardHours?: number;
  /** Only set when caller had finance:read at validate time. */
  salaryHourly?: number;
  /** Plaintext — hashed at commit time, then surfaced in afterJson. */
  generatedPassword: string;
}

// Header names in the downloadable template. Keep matching to header
// in the validateRows mapping below.
const COLUMNS = [
  'Email',
  'First Name',
  'Last Name',
  'Phone',
  'Role',
  'User Type',
  'Position',
  'Department',
  'Employee Category',
  'Employment Date',
  'Employment End Date',
  'Seniority Level',
  'Daily Standard Hours',
  'Hourly Rate',
] as const;

const FINANCE_COLUMNS = new Set(['Hourly Rate']);

@Injectable()
export class UsersImporterService implements EntityImporter<UserImportRow> {
  private readonly logger = new Logger(UsersImporterService.name);
  readonly target: DataImportTarget = 'users';
  readonly templateColumns = [...COLUMNS];

  constructor(private readonly prisma: PrismaService) {}

  async generateTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Planwise';
    wb.created = new Date();
    const sheet = wb.addWorksheet('Employees');

    // Header row — bold, slight background tint, autofilter on
    sheet.columns = COLUMNS.map((c) => ({ header: c, key: c, width: 22 }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

    // Example row so users see expected format. Strings only — Excel
    // auto-infers types from the cell.
    sheet.addRow({
      Email: 'jane.doe@example.com',
      'First Name': 'Jane',
      'Last Name': 'Doe',
      Phone: '+972-50-1234567',
      Role: 'Engineer',
      'User Type': 'employee',
      Position: 'Senior Architect',
      Department: 'Design',
      'Employee Category': 'Internal',
      'Employment Date': '2026-01-15',
      'Employment End Date': '',
      'Seniority Level': 'Senior',
      'Daily Standard Hours': '8',
      'Hourly Rate': '120',
    });

    // Help row — gray italic instructions for each column. Excel users
    // see this when they open the template; they overwrite it once they
    // start filling in real data. Row 2 is the example, row 3 is help.
    const helpRow = sheet.addRow({
      Email: 'Required, unique',
      'First Name': 'Required',
      'Last Name': 'Required',
      Phone: 'Optional',
      Role: 'Must match a role name in /admin/roles',
      'User Type': 'employee | partner | both (default employee)',
      Position: 'Optional',
      Department: 'Optional',
      'Employee Category': 'Optional',
      'Employment Date': 'YYYY-MM-DD',
      'Employment End Date': 'YYYY-MM-DD or blank',
      'Seniority Level': 'Must match a seniority level name',
      'Daily Standard Hours': 'Number (e.g. 8)',
      'Hourly Rate': 'Number — visible only with Finance permission',
    });
    helpRow.font = { italic: true, color: { argb: 'FF6B7280' } };

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer as ArrayBuffer);
  }

  async validateRows(
    rows: Array<Record<string, string>>,
    ctx: ValidationContext,
  ): Promise<Array<ValidatedRow<UserImportRow>>> {
    // Pre-load all the lookup tables once so we don't N+1 the DB across
    // a 10k-row import. We compare case-insensitively because users
    // typing role names won't always match exact capitalization.
    const [roles, seniorityLevels, existingEmails] = await Promise.all([
      this.prisma.role.findMany({ select: { id: true, name: true } }),
      this.prisma.seniorityLevel.findMany({ select: { id: true, name: true, code: true } }),
      this.prisma.user.findMany({
        where: { deletedAt: null },
        select: { email: true },
      }),
    ]);

    const roleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r]));
    const seniorityByName = new Map<string, { id: number; name: string }>();
    for (const s of seniorityLevels) {
      seniorityByName.set(s.name.toLowerCase(), { id: s.id, name: s.name });
      if (s.code) seniorityByName.set(s.code.toLowerCase(), { id: s.id, name: s.name });
    }
    const existingEmailSet = new Set(existingEmails.map((u) => u.email.toLowerCase()));

    // Also detect duplicates WITHIN the same upload — two rows with the
    // same email would fail the unique constraint mid-commit otherwise.
    const fileEmailCount = new Map<string, number>();
    for (const r of rows) {
      const e = (r['Email'] ?? '').trim().toLowerCase();
      if (e) fileEmailCount.set(e, (fileEmailCount.get(e) ?? 0) + 1);
    }

    const results: Array<ValidatedRow<UserImportRow>> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const errors: ValidatedRow<UserImportRow>['errors'] = [];

      const email = (r['Email'] ?? '').trim().toLowerCase();
      const firstName = (r['First Name'] ?? '').trim();
      const lastName = (r['Last Name'] ?? '').trim();
      const phone = (r['Phone'] ?? '').trim();
      const roleName = (r['Role'] ?? '').trim();
      const userTypeRaw = (r['User Type'] ?? 'employee').trim().toLowerCase();
      const position = (r['Position'] ?? '').trim();
      const department = (r['Department'] ?? '').trim();
      const employeeCategory = (r['Employee Category'] ?? '').trim();
      const employmentDateStr = (r['Employment Date'] ?? '').trim();
      const employmentEndDateStr = (r['Employment End Date'] ?? '').trim();
      const seniorityName = (r['Seniority Level'] ?? '').trim();
      const dailyStdHoursStr = (r['Daily Standard Hours'] ?? '').trim();
      const hourlyRateStr = ctx.canSeeFinance ? (r['Hourly Rate'] ?? '').trim() : '';

      // ─── Required fields ─────────────────────────────────────────
      if (!email) errors.push({ field: 'Email', message: 'Email is required.' });
      else if (!isValidEmail(email))
        errors.push({ field: 'Email', message: `Email "${email}" is not a valid address.` });
      if (!firstName) errors.push({ field: 'First Name', message: 'First name is required.' });
      if (!lastName) errors.push({ field: 'Last Name', message: 'Last name is required.' });
      if (!roleName) errors.push({ field: 'Role', message: 'Role is required.' });

      // ─── FK lookups ─────────────────────────────────────────────
      const role = roleName ? roleByName.get(roleName.toLowerCase()) : undefined;
      if (roleName && !role) {
        errors.push({
          field: 'Role',
          message: `Role "${roleName}" not found. Create it in /admin/roles first, or use one of: ${roles
            .slice(0, 5)
            .map((x) => x.name)
            .join(', ')}…`,
        });
      }

      let userType: UserType = 'employee';
      if (userTypeRaw === 'partner') userType = 'partner';
      else if (userTypeRaw === 'both') userType = 'both';
      else if (userTypeRaw && userTypeRaw !== 'employee') {
        errors.push({
          field: 'User Type',
          message: `User Type must be one of: employee, partner, both. Got "${r['User Type']}".`,
        });
      }

      let seniorityLevelId: number | undefined;
      if (seniorityName) {
        const sen = seniorityByName.get(seniorityName.toLowerCase());
        if (!sen) {
          errors.push({
            field: 'Seniority Level',
            message: `Seniority Level "${seniorityName}" not found. Configure it under /admin first.`,
          });
        } else {
          seniorityLevelId = sen.id;
        }
      }

      // ─── Date parsing ───────────────────────────────────────────
      let employmentDate: Date | undefined;
      if (employmentDateStr) {
        const d = parseISODate(employmentDateStr);
        if (!d) errors.push({ field: 'Employment Date', message: `Invalid date "${employmentDateStr}". Use YYYY-MM-DD.` });
        else employmentDate = d;
      }
      let employmentEndDate: Date | undefined;
      if (employmentEndDateStr) {
        const d = parseISODate(employmentEndDateStr);
        if (!d) errors.push({ field: 'Employment End Date', message: `Invalid date "${employmentEndDateStr}". Use YYYY-MM-DD.` });
        else employmentEndDate = d;
      }

      // Seniority needs a start date — fall back to employment date,
      // else "today" so the open-ended history row is at least valid.
      if (seniorityLevelId && !employmentDate) {
        errors.push({
          field: 'Seniority Level',
          message: 'Seniority Level requires an Employment Date — it becomes the start date for the seniority history.',
        });
      }

      // ─── Numbers ────────────────────────────────────────────────
      let dailyStandardHours: number | undefined;
      if (dailyStdHoursStr) {
        const n = Number(dailyStdHoursStr);
        if (!Number.isFinite(n) || n < 0 || n > 24)
          errors.push({ field: 'Daily Standard Hours', message: `Daily Standard Hours must be 0–24. Got "${dailyStdHoursStr}".` });
        else dailyStandardHours = n;
      }
      let salaryHourly: number | undefined;
      if (hourlyRateStr) {
        const n = Number(hourlyRateStr);
        if (!Number.isFinite(n) || n < 0)
          errors.push({ field: 'Hourly Rate', message: `Hourly Rate must be a non-negative number. Got "${hourlyRateStr}".` });
        else salaryHourly = n;
      }

      // ─── Uniqueness ─────────────────────────────────────────────
      let conflictsWithExisting = false;
      if (email) {
        if ((fileEmailCount.get(email) ?? 0) > 1) {
          errors.push({
            field: 'Email',
            message: `Email "${email}" appears more than once in this file.`,
          });
        }
        if (existingEmailSet.has(email)) {
          conflictsWithExisting = true;
          // For insert-only mode this becomes a skip, not an error. The
          // commit phase decides based on the mode; here we just flag.
        }
      }

      results.push({
        rowIndex: i + 1,
        data: errors.length === 0 && role
          ? {
              email,
              firstName,
              lastName,
              phone: phone || undefined,
              roleId: role.id,
              userType,
              position: position || undefined,
              department: department || undefined,
              employeeCategory: employeeCategory || undefined,
              employmentDate,
              employmentEndDate,
              seniorityLevelId,
              dailyStandardHours,
              salaryHourly,
              // Generate a strong random password per row. We surface
              // the plaintext in afterJson so admins can distribute it
              // out-of-band (the user resets via the normal flow on
              // first login). Bcrypt-hashed at commit time.
              generatedPassword: generateTempPassword(),
            }
          : null,
        conflictsWithExisting,
        errors,
      });
    }

    return results;
  }

  async commit({
    importId,
    rows,
    mode,
    userId: _runnerUserId,
  }: {
    importId: number;
    rows: Array<ValidatedRow<UserImportRow>>;
    mode: DataImportMode;
    userId: number;
  }): Promise<CommitResult> {
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // We use a transaction PER ROW (not for the whole import) so a single
    // bad row doesn't roll back the rest. The user is told up-front to
    // fix all validation errors before commit, so this only protects
    // against late race conditions (e.g. another admin creates a user
    // with the same email between validate and commit).
    for (const r of rows) {
      try {
        if (!r.data || r.errors.length > 0) {
          await this.recordRow(importId, r.rowIndex, 'failed', null, null, r.errors.map((e) => e.message).join('; '));
          errorCount++;
          continue;
        }

        if (r.conflictsWithExisting && mode === 'insert') {
          await this.recordRow(importId, r.rowIndex, 'skipped', null, r.data, 'Email already exists (insert-only mode).');
          skippedCount++;
          continue;
        }

        if (mode !== 'insert') {
          // M2+. Surface clearly so we don't silently no-op.
          throw new Error(`Mode "${mode}" not implemented yet — coming in M2.`);
        }

        // Insert path. Wrap user + seniority history in one prisma
        // transaction so we never have a user without their initial
        // seniority row (or vice versa).
        const created = await this.prisma.$transaction(async (tx) => {
          const passwordHash = await bcrypt.hash(r.data!.generatedPassword, 10);
          const user = await tx.user.create({
            data: {
              email: r.data!.email,
              firstName: r.data!.firstName,
              lastName: r.data!.lastName,
              phone: r.data!.phone,
              password: passwordHash,
              roleId: r.data!.roleId,
              userType: r.data!.userType,
              position: r.data!.position,
              department: r.data!.department,
              employeeCategory: r.data!.employeeCategory,
              employmentDate: r.data!.employmentDate,
              employmentEndDate: r.data!.employmentEndDate,
              seniorityLevelId: r.data!.seniorityLevelId,
              dailyStandardHours: r.data!.dailyStandardHours,
              salaryHourly: r.data!.salaryHourly,
              createdByImportId: importId,
            },
          });

          // Seniority history row — date-effective. Open-ended (endDate
          // null) so it's the current row. Cost calculations from
          // employmentDate onward will use this seniority level.
          if (r.data!.seniorityLevelId && r.data!.employmentDate) {
            await tx.userSeniority.create({
              data: {
                userId: user.id,
                seniorityLevelId: r.data!.seniorityLevelId,
                startDate: r.data!.employmentDate,
                endDate: null,
                notes: `Created by data import #${importId}`,
              },
            });
          }

          return user;
        });

        // Strip the password BEFORE writing to afterJson — we DO want
        // the plaintext visible in the per-row report so the admin can
        // distribute it, but only to that admin (the report is gated
        // by the import-runner). Keep password but drop the hash.
        const afterForLog = { ...r.data, userId: created.id, password: undefined };
        await this.recordRow(importId, r.rowIndex, 'created', created.id, afterForLog, null);
        createdCount++;
      } catch (e: any) {
        this.logger.warn(`Row ${r.rowIndex} failed: ${e.message}`);
        await this.recordRow(importId, r.rowIndex, 'failed', null, r.data, e.message);
        errorCount++;
      }
    }

    return { createdCount, updatedCount, skippedCount, errorCount };
  }

  async rollback(importId: number): Promise<{ deletedCount: number; restoredCount: number }> {
    // For insert-only imports we just delete the tagged users. The FK
    // on user_seniorities is ON DELETE CASCADE, so seniority history
    // rows go with them. Same for any other CASCADE relations.
    //
    // We do NOT delete users with createdByImportId set but who have
    // since been edited or linked to projects/tasks/time entries — a
    // future safety check could refuse if the user has any TimeEntry
    // rows, but for v1 we trust the 30-day expiry window to protect
    // against late surprises.
    const result = await this.prisma.user.deleteMany({
      where: { createdByImportId: importId },
    });
    return { deletedCount: result.count, restoredCount: 0 };
  }

  private async recordRow(
    importId: number,
    rowIndex: number,
    outcome: 'created' | 'updated' | 'skipped' | 'failed',
    entityId: number | null,
    after: any,
    errorMessage: string | null,
  ) {
    await this.prisma.dataImportRow.create({
      data: {
        importId,
        rowIndex,
        outcome,
        entityId,
        errorMessage,
        afterJson: after ?? undefined,
      },
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function isValidEmail(s: string): boolean {
  // Tighter than full RFC-5321 but catches the realistic typos. The
  // backend's downstream code also has its own checks; this is the
  // first line of defense.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function parseISODate(s: string): Date | undefined {
  // Accept YYYY-MM-DD; Excel often serializes dates this way on export.
  // Anything else is rejected — we'd rather surface a clear error than
  // guess Date.parse-style fuzziness.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? undefined : dt;
}

function generateTempPassword(): string {
  // 12-char URL-safe random — enough entropy that no two imported users
  // share a password by accident even at 10k rows.
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '');
}
