import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * HR Phase D1 (2026-10-18) — DTO for the consolidated accounting
 * report. Three scope modes keep the FE picker's shape explicit on
 * the wire; the service branches on `scope.kind` after validation.
 *
 * `all-active`  — every active employee (no extra field required)
 * `org-unit`    — one OrgUnit + its subtree (via materialised path)
 * `manual`      — explicit userIds[] from a multi-select
 */
export type ReportScope =
  | { kind: 'all-active' }
  | { kind: 'org-unit'; orgUnitId: number }
  | { kind: 'manual'; userIds: number[] };

export class ReportScopeDto {
  @IsIn(['all-active', 'org-unit', 'manual'])
  kind!: 'all-active' | 'org-unit' | 'manual';

  @ValidateIf((o) => o.kind === 'org-unit')
  @IsInt()
  orgUnitId?: number;

  @ValidateIf((o) => o.kind === 'manual')
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}

export class BuildReportDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  // class-validator's deep-validation of a plain object property is
  // controller-level; keep this permissive and lean on the service to
  // re-check `scope.kind` + its payload. The controller still rejects
  // malformed year/month before we touch the DB.
  scope!: ReportScope;
}
