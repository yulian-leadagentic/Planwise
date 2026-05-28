import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  // Cap raised 100 → 1000. Several "load everything" surfaces (the
  // archived-tasks modal, partner/employee pickers, zone lists, the
  // project list used for dropdowns) legitimately request large pages
  // and were silently 400ing on `perPage must not be greater than 100`
  // — which surfaced to users as empty modals/lists (e.g. the Archived
  // Tasks modal showing "No archived tasks" even when tasks existed).
  // 1000 comfortably covers every current caller while still bounding
  // a hostile request. Default page size stays 20.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  perPage?: number = 20;

  get skip(): number {
    return ((this.page ?? 1) - 1) * (this.perPage ?? 20);
  }

  get take(): number {
    return this.perPage ?? 20;
  }
}
