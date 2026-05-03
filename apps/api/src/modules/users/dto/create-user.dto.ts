import { IsString, IsEmail, IsOptional, IsInt, IsEnum, IsBoolean, IsNumber, IsDateString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { UserType } from '@prisma/client';

export class CreateUserDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty()
  @IsInt()
  @Type(() => Number)
  roleId: number;

  @ApiProperty({ enum: UserType })
  @IsEnum(UserType)
  userType: UserType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  position?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  department?: string;

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
}
