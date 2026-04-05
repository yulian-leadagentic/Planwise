import { IsString, IsOptional, IsInt, MaxLength } from 'class-validator';

export class CreatePhaseDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
