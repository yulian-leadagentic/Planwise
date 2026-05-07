import { IsInt, IsOptional, IsString, IsNumber, IsDateString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto {
  // Optional — tasks without a zoneId attach directly to the project
  // ("project root"). The planning grid groups these in a Project Root
  // section above any zoned tasks. If zoneId is omitted, projectId is
  // required so the service knows which project to attach to.
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  zoneId?: number | null;

  @ApiPropertyOptional({ description: 'Required when zoneId is omitted (project-root task).' })
  @IsOptional()
  @IsInt()
  projectId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  serviceTypeId?: number;

  @ApiProperty()
  @IsString()
  @MaxLength(50)
  code: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  budgetHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  budgetAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  phaseId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  priority?: string;

  /** Planning forecast — when work is *expected* to begin. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  estimatedStartDate?: string;
}
