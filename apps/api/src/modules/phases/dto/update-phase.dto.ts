import { PartialType } from '@nestjs/mapped-types';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';
import { CreatePhaseDto } from './create-phase.dto';

export class UpdatePhaseDto extends PartialType(CreatePhaseDto) {
  /**
   * QA6 PR-063 — the Qualifications (`professions.id`) a person must hold
   * at least one of to be given a task of this service. `null` or `[]`
   * clears the requirement; omitted = unchanged. Ids are checked against
   * the professions table (400 PROFESSION_NOT_FOUND).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  @Min(1, { each: true })
  requiredProfessionIds?: number[] | null;
}
