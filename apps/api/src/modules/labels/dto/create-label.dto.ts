import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateLabelDto {
  @ApiProperty()
  @IsInt()
  projectId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  parentId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  labelTypeId?: number;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  color?: string;
}
