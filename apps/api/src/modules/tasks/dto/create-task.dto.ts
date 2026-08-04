import { IsInt, IsOptional, IsString, IsNumber, IsDateString, IsBoolean, MaxLength, Min } from 'class-validator';
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

  /** Source Deliverable (Template with type=task_list). Set when the
   *  task was materialized from a deliverable template, OR explicitly
   *  picked via the inline Deliverable cell on the planning grid. */
  @ApiPropertyOptional({ description: 'Source Template (deliverable) id.' })
  @IsOptional()
  @IsInt()
  deliverableTemplateId?: number | null;

  /** The first-class, project-owned Deliverable this task belongs to. This
   *  is the authoritative link the board / reports resolve from. Usually set
   *  together with deliverableTemplateId (kept synced for provenance). */
  @ApiPropertyOptional({ description: 'ProjectDeliverable id (project-owned).' })
  @IsOptional()
  @IsInt()
  projectDeliverableId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  priority?: string;

  /** Planning forecast — when work is *expected* to begin. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  estimatedStartDate?: string | null;

  /** Due date. Required for personal tasks (enforced by the frontend
   *  personal-task form); optional for regular tasks that inherit from
   *  their Deliverable target date via auto-propagation. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  /** Personal task (Tier D #1). When true, project/zone/service/
   *  deliverable are all optional and the task doesn't count toward
   *  any Deliverable's completion %. Still visible in My Tasks. */
  @ApiPropertyOptional({ description: 'True → personal task; project/zone/etc. are optional.' })
  @IsOptional()
  @IsBoolean()
  isPersonal?: boolean;

  /** Optional Review step (Tier D #2). Default true — set false and
   *  the task can transition in_progress → completed directly, no
   *  in_review stop. */
  @ApiPropertyOptional({ description: 'False → skip in_review; go straight to completed.' })
  @IsOptional()
  @IsBoolean()
  requiresReview?: boolean;
}
