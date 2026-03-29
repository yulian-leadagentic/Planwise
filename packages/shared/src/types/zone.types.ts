export interface ZoneType {
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
  zoneType?: ZoneType;
  children?: Zone[];
  assignmentCount?: number;
}
