import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsNumber, IsDateString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType } from '@prisma/client';

/**
 * HR Phase A3 (2026-10-15) — fields the HR drawer may PATCH on an
 * employee. Deliberately narrower than UpdateUserDto: the HR module
 * only touches employment/payroll metadata and the standard-hours
 * knob. Everything else (role, email, SSO linkage, orgUnit) continues
 * to live on /users under the Admin surface. The guard pipes this
 * through `hr:write`; the service writes directly to the User row.
 */
export class UpdateHrEmployeeDto {
  @ApiPropertyOptional({ enum: EmploymentType, description: 'GLOBAL (salaried) or HOURLY — drives overtime calc in Phase B.' })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType | null;

  @ApiPropertyOptional({ description: 'Payroll employee number from the accounting system. Free-form, max 50 chars.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountingEmployeeNumber?: string | null;

  @ApiPropertyOptional({ description: 'Daily standard hours (e.g. 8.0 for a full-time employee).' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  dailyStandardHours?: number | null;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd.' })
  @IsOptional()
  @IsDateString()
  employmentDate?: string | null;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd.' })
  @IsOptional()
  @IsDateString()
  employmentEndDate?: string | null;
}
