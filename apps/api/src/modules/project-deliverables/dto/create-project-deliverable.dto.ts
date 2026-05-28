import { IsInt, IsOptional, IsString, MinLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectDeliverableDto {
  @ApiProperty()
  @IsInt()
  projectId: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  /** Catalog template this deliverable is instantiated from (optional — a
   *  project may have ad-hoc deliverables with no catalog source). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sourceTemplateId?: number;

  /** The Service (Phase) line this deliverable belongs to. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  serviceId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
