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
  // Set when the PM closes a project; null when active. Backend
  // model: schema.prisma `closedAt DateTime? @map("closed_at")` on
  // Project; `include:` returns it as an ISO date string. Gates the
  // "This project is closed" banner on the detail page.
  closedAt: string | null;
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
  // Backend Prisma model (schema.prisma `model ProjectType`) declares
  // these too and the /admin/config/project-types endpoint returns
  // them all (no `select:` narrow — just `include: { _count }`).
  // Shared type was out of date, hiding the color chip from tsc.
  code: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}
