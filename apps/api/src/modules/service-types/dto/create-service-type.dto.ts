import { IsString, IsOptional, IsInt, MaxLength, Matches } from 'class-validator';

export class CreateServiceTypeDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
