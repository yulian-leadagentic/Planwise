import { IsOptional, IsString, IsInt, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  entityId?: number;

  // QA4 A1: caller may narrow the returned rows to authored (user) or
  // system-generated messages. `meta.total` is ALWAYS the authored
  // count regardless of this filter — see findByEntity for rationale.
  @ApiPropertyOptional({ enum: ['user', 'system'] })
  @IsOptional()
  @IsString()
  @IsIn(['user', 'system'])
  type?: 'user' | 'system';
}
