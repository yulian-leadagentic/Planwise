import { TaskStatus, TaskPriority } from './enums';

export interface Task {
  id: number;
  labelId: number;
  name: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  budgetHours: number | null;
  budgetAmount: number | null;
  startDate: string | null;
  endDate: string | null;
  completionPct: number;
  isArchived: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  label?: {
    id: number;
    name: string;
    path: string;
    projectId: number;
    projectName?: string;
  };
  assignees?: TaskAssignee[];
  loggedMinutes?: number;
}

export interface TaskAssignee {
  id: number;
  taskId: number;
  userId: number;
  role: string | null;
  hourlyRate: number | null;
  startDate: string | null;
  endDate: string | null;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
}

export interface TaskComment {
  id: number;
  taskId: number;
  userId: number;
  parentId: number | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
  replies?: TaskComment[];
}

export interface TaskPlanTime {
  id: number;
  taskId: number;
  roleTitle: string;
  plannedHours: number;
}
