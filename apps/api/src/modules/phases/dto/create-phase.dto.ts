import { IsString, IsOptional, IsInt, MaxLength } from 'class-validator';

export class CreatePhaseDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
