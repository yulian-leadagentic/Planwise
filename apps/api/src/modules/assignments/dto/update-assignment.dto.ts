import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateAssignmentDto } from './create-assignment.dto';

export class UpdateAssignmentDto extends PartialType(
  OmitType(CreateAssignmentDto, ['deliverableId'] as const),
) {}
