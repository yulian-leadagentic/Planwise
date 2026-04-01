import { PartialType } from '@nestjs/mapped-types';
import { CreateServiceTypeDto } from './create-service-type.dto';

export class UpdateServiceTypeDto extends PartialType(CreateServiceTypeDto) {}
