import { DeliverableScope, AssignmentStatus, AssignmentPriority } from './enums';

export interface Service {
  id: number;
  projectId: number;
  name: string;
  code: string | null;
  sortOrder: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  deliverables?: Deliverable[];
}

export interface Deliverable {
  id: number;
  serviceId: number;
  name: string;
  code: string | null;
  percentage: number | null;
  scope: DeliverableScope;
  sortOrder: number;
  description: string | null;
  budgetHours: number | null;
  createdAt: string;
  updatedAt: string;
  service?: Service;
  assignments?: Assignment[];
  linkedZoneCount?: number;
}

export interface Assignment {
  id: number;
  deliverableId: number;
  zoneId: number | null;
  name: string;
  description: string | null;
  status: AssignmentStatus;
  priority: AssignmentPriority;
  budgetHours: number | null;
  budgetAmount: number | null;
  completionPct: number;
  startDate: string | null;
  endDate: string | null;
  isArchived: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  deliverable?: Deliverable;
  zone?: {
    id: number;
    name: string;
    code: string | null;
    path: string;
  };
  assignees?: AssignmentAssignee[];
  loggedMinutes?: number;
}

export interface AssignmentAssignee {
  id: number;
  assignmentId: number;
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

export interface AssignmentComment {
  id: number;
  assignmentId: number;
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
  replies?: AssignmentComment[];
}

export interface ZoneAssignment {
  id: number;
  zoneId: number;
  deliverableId: number;
  isPrimary: boolean;
  createdAt: string;
}

export interface BreakdownReview {
  id: number;
  projectId: number;
  reviewerId: number;
  status: 'pending' | 'approved' | 'changes_requested';
  notes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  reviewer?: {
    id: number;
    firstName: string;
    lastName: string;
  };
}

export interface ChangeOrder {
  id: number;
  contractId: number;
  name: string;
  amount: number;
  description: string | null;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy: number | null;
  approvedAt: string | null;
  createdBy: number;
  createdAt: string;
}

export interface ContractAllocation {
  id: number;
  contractItemId: number;
  deliverableId: number;
  zoneId: number | null;
  amount: number;
  createdAt: string;
}

export interface ContractMilestoneV2 {
  id: number;
  contractItemId: number;
  name: string;
  percentage: number;
  amount: number;
  isCompleted: boolean;
  completedAt: string | null;
  sortOrder: number;
}

export interface PlanningData {
  project: {
    id: number;
    name: string;
    status: string;
  };
  zones: import('./zone.types').Zone[];
  services: Service[];
  assignments: Assignment[];
  contracts: {
    id: number;
    name: string;
    totalAmount: number | null;
    items: {
      id: number;
      name: string;
      amount: number;
      allocations: ContractAllocation[];
    }[];
  }[];
  budgetSummary: {
    bottomUp: number;
    topDown: number;
    variance: number;
    variancePct: number;
  };
}
