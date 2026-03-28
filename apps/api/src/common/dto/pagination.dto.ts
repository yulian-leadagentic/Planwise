import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number = 20;

  get skip(): number {
    return ((this.page ?? 1) - 1) * (this.perPage ?? 20);
  }

  get take(): number {
    return this.perPage ?? 20;
  }
}
