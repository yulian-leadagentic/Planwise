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
  /**
   * Rolled-up actual hours logged across every non-personal task on
   * the project (sum of `TimeEntry.minutes / 60`, task-scoped).
   * Populated by `GET /projects` (projects list) — the detail
   * endpoint's Labor Cost tab surfaces the per-user breakdown
   * separately. `0` when no time is logged; not present on payloads
   * that don't compute it.
   */
  actualHours?: number;
  /**
   * Rolled-up actual labor cost — Σ(hours × seniority hourly cost)
   * across contributors, in the seniority level's currency. Unrateable
   * minutes (no seniority row / no hourly cost) are excluded from Cost
   * but still counted in `actualHours` (matches
   * `getLaborCost#totalLoggedHours` vs per-currency totals). Finance-
   * gated on the server — omitted from the payload when the caller
   * lacks `finance:read`.
   */
  actualCost?: number;
  /**
   * Rolled-up completion % (0–100, integer) — budget-hours-weighted
   * average of `task.completionPct` across non-personal, non-archived,
   * non-deleted tasks, with a simple-mean fallback for buckets with
   * zero budget hours. Matches
   * `execution-planning.service#getProjectProgress`. `0` on projects
   * with no tasks; not present on payloads that don't compute it.
   */
  completionPct?: number;
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
