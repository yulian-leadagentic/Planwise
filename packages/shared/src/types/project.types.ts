import { ProjectStatus } from './enums';

export interface Project {
  id: number;
  name: string;
  number: string | null;
  description: string | null;
  projectTypeId: number;
  projectTypeName?: string;
  status: ProjectStatus;
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
  isArchived: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: number;
  projectId: number;
  userId: number;
  role: string | null;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
  createdAt: string;
}

export interface ProjectType {
  id: number;
  name: string;
}
