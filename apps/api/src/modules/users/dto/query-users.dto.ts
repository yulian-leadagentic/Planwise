import { IsOptional, IsEnum, IsString, IsInt, IsBoolean, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { UserType } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryUsersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UserType })
  @IsOptional()
  @IsEnum(UserType)
  userType?: UserType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  roleId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Active filter. Defaults to true (active only) on the service if omitted.
   * Accepts: true | false | 'all' (admin override to include both).
   */
  @ApiPropertyOptional({ description: 'true | false | "all"' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'all' || value === '*') return 'all';
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  isActive?: boolean | 'all';
}
