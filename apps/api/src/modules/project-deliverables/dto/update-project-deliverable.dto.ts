import { IsInt, IsOptional, IsString, MinLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProjectDeliverableDto {
  /** Rename — this is the project-owned label seen by the PM and customer. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  /** Re-assign the Service (Phase) line. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  serviceId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
