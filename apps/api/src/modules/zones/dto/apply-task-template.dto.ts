import { IsInt, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of `POST /zones/apply-task-template` — apply a Deliverable
 * Template (Template.type = 'task_list') into a zone or the project
 * root in one transaction: its tasks AND the dependency edges between
 * them (see `ZonesService.applyTaskTemplateToTarget`).
 *
 * The four optional context fields are the planning-modal group context
 * (web `TaskAddContext`): whichever dimension the group card the PM
 * added from represents. `null` and "omitted" mean the same thing.
 */
export class ApplyTaskTemplateDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  projectId: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  templateId: number;

  @ApiPropertyOptional({ nullable: true, description: 'Target zone. Null / omitted = project root.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  zoneId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  projectDeliverableId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  deliverableTemplateId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  phaseId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  serviceTypeId?: number | null;
}
