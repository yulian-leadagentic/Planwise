export interface Label {
  id: number;
  projectId: number;
  parentId: number | null;
  labelTypeId: number;
  name: string;
  path: string;
  depth: number;
  sortOrder: number;
  description: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
  labelType?: LabelType;
  children?: Label[];
  taskCount?: number;
}

export interface LabelType {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
}
