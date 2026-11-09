import { PartialType } from '@nestjs/mapped-types';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsInt, IsString, IsDateString, Min, Max, ValidateIf } from 'class-validator';

import { CreateTaskDto } from './create-task.dto';

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  completionPct?: number;

  // The three date fields must accept BOTH a valid date string AND `null`
  // (the explicit "clear this date" signal). class-validator's @IsOptional
  // skips downstream validators on null/undefined, BUT class-transformer
  // (transform: true on the global pipe) was silently stripping nulls on
  // fields typed as plain `string` — clearing the due date appeared to
  // succeed but the value never reached the service. Declaring the field
  // as `string | null` plus @ValidateIf to skip @IsDateString on null
  // makes both intent and runtime behavior unambiguous.

  /** Planning forecast — when work is *expected* to begin. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  estimatedStartDate?: string | null;

  /** Actual start — when work physically began. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;

  /**
   * Explicit-user-intent signal for the per-task due-date editor
   * (§B · override hardening, 2026-11-09).
   *
   * Only true when the DTO originates from a PM clicking the per-task
   * date editor control on a SINGLE task row — the drawer's Due Date
   * input, the health-banner DueDateChip, the Planning grid's inline
   * date cell, or the Deliverable-Tasks modal's per-row date input.
   * Every automatic path that updates a task's endDate (deliverable-
   * target propagation, Gantt drag commit, scheduler save, clear-date
   * affordances) MUST leave this flag unset so `dueDateOverridden` is
   * NOT fired and the scheduler keeps re-chaining the task.
   *
   * Stripped from the DTO before Prisma writes (schema does not carry
   * this field — it is a transport-only signal).
   */
  @ApiPropertyOptional({
    description:
      'Explicit-user-intent flag. Only true when the PM manually edits a single task\'s due date; automatic writes must leave it unset so dueDateOverridden stays false.',
  })
  @IsOptional()
  @IsBoolean()
  manualDueDate?: boolean;
}
