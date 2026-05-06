// V8 zone-type DB row (presentation metadata for the enum). Renamed from
// `ZoneType` to `ZoneTypeDef` so it doesn't collide with the enum-derived
// `ZoneType` string-union exported from ./enums (also re-exported by the
// package barrel). Consumers that want the enum value use `ZoneType`;
// consumers that want the row shape use `ZoneTypeDef`.
export interface ZoneTypeDef {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
}

export interface Zone {
  id: number;
  projectId: number;
  parentId: number | null;
  zoneTypeId: number;
  name: string;
  code: string | null;
  areaSqm: number | null;
  path: string;
  depth: number;
  sortOrder: number;
  description: string | null;
  color: string | null;
  isTypical: boolean;
  typicalCount: number;
  createdAt: string;
  updatedAt: string;
  zoneType?: ZoneTypeDef;
  children?: Zone[];
  assignmentCount?: number;
}
