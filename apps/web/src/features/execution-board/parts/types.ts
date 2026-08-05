/**
 * Shared type definitions for the Execution Board and its sub-components.
 * Extracted from execution-board-page.tsx so display components under
 * `./parts/` can reuse them without importing back from the page module.
 */

export interface TemplateRef {
  id: number;
  name: string;
  code: string | null;
  phaseId: number | null;
  phase: { id: number; name: string; color: string | null } | null;
}

export interface Service {
  id: number;
  name: string;
  code: string | null;
  color: string | null;
}

export interface Assignee {
  user: { id: number; firstName: string; lastName: string; avatarUrl: string | null };
}

export interface Task {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: string;
  completionPct: number;
  budgetHours: number | null;
  endDate: string | null;
  loggedMinutes: number;
  lastActivityDate: string | null;
  /** Nullable — a task may live at the project root with no parent zone. */
  zoneId: number | null;
  projectId: number;
  serviceTypeId: number | null;
  phaseId: number | null;
  serviceType: { id: number; name: string; code: string | null; color: string | null } | null;
  phase: Service | null;
  assignees: Assignee[];
}

export interface ZoneNode {
  id: number;
  name: string;
  zoneType: string;
  projectId: number;
  parentId: number | null;
  children: ZoneNode[];
}

export interface Project {
  id: number;
  name: string;
  number: string | null;
  status: string;
}

export interface BoardData {
  projects: Project[];
  zones: Record<number, ZoneNode[]>;
  tasks: Task[];
  services: Service[];
  templates: TemplateRef[];
}

export interface FlatRow {
  type: 'project' | 'zone';
  id: number;
  key: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  /**
   * True for zone rows that have no parent ZONE above them (i.e. they sit
   * directly under a project, not under another zone). Used to decide whether
   * to render the progress bar — only top-level zones do, sub-zones get just
   * the % + health badge. We can't infer this from `depth` alone because
   * `depth=0` is the project row in multi-project view (zones start at depth=1
   * there) but the top zone in single-project view (depth=0).
   */
  isTopLevelZone?: boolean;
  projectId?: number;
  zoneType?: string;
  number?: string | null;
}
