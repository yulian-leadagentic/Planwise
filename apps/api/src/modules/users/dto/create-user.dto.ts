import { IsString, IsEmail, IsOptional, IsInt, IsEnum, IsBoolean, IsNumber, IsDateString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { UserType } from '@prisma/client';

export class CreateUserDto {
  /**
   * M1.1 — Optional business code. Required when the EMPLOYEE entity-kind's
   * range is in manual/external mode (admin-supplied). Omitted when in
   * auto mode (system allocates).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty()
  @IsString()
  firstName: string;

  @ApiProperty()
  @IsString()
  lastName: string;

  /** Optional Hebrew rendering — picks up the bilingual search index.
   *  T3.3 (2026-06-28). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  firstNameHe?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastNameHe?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty()
  @IsInt()
  @Type(() => Number)
  roleId: number;

  /**
   * Phase 4 · Stage 1c (2026-09-28) — READ-ONLY from clients.
   * Kept optional in the DTO for backward compatibility with existing FE
   * forms that still post it, but the value is IGNORED server-side: the
   * D1 rule (email domain vs. home org's owned domains) is the single
   * source of truth and the service overwrites this field on every
   * write.
   */
  @ApiPropertyOptional({ enum: UserType, description: 'IGNORED — derived from D1 rule server-side' })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  position?: string;

  /**
   * Retire-User.department Step 1/3 (2026-09-28) — the free-text
   * `department` field is now retired from the write DTO. Clients
   * must send `orgUnitId` instead. Because the global ValidationPipe
   * runs with `forbidNonWhitelisted: true`, a stale FE that still
   * posts `department: '...'` will now get a 400 — the Step 2/3 FE
   * commit lands together with this one to keep the create/edit
   * modals in sync. Reads still surface `department` for one release
   * so mid-deploy consumers can fall back on it (see users.service.ts
   * selects).
   *
   * `orgUnitId`: single source of truth for org-tree membership.
   * Nullable / optional so the People inline cell and edit modal can
   * PATCH just this field.
   */
  @ApiPropertyOptional({ description: 'OrgUnit id — replaces free-text department' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  orgUnitId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  taxId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  website?: string;

  // ─── HR fields (employee-only, optional) ────────────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  salaryHourly?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  dailyStandardHours?: number;

  @ApiPropertyOptional({ description: 'SeniorityLevel.id; drives default hourly cost for project labor calc' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  seniorityLevelId?: number;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd' })
  @IsOptional()
  @IsDateString()
  employmentDate?: string;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd' })
  @IsOptional()
  @IsDateString()
  employmentEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeCategory?: string;

  // ─── Business Partner linkage (optional) ────────────────────────────────

  /**
   * If set, the created User's BP will get an `employee_of` relationship
   * to this organization BP.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  employerOrgId?: number;

  /**
   * Link the new login to an *existing* Business Partner (person) instead
   * of creating a fresh BP. Used when a contact has already been captured
   * under Partners → Contacts and we just want to give them access to the
   * app. Skips the email-match auto-link path.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  businessPartnerId?: number;
}
