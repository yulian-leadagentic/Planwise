export interface TimesheetReport {
  rows: {
    userId: number;
    userName: string;
    projectName?: string;
    taskName?: string;
    labelPath?: string;
    totalMinutes: number;
    billableMinutes: number;
    dates: Record<string, number>;
  }[];
  totals: {
    totalMinutes: number;
    billableMinutes: number;
  };
}

export interface AttendanceReport {
  rows: {
    userId: number;
    userName: string;
    daysPresent: number;
    daysSick: number;
    daysLeave: number;
    daysAbsent: number;
    daysLate: number;
    totalWorkedMinutes: number;
    totalExpectedMinutes: number;
    totalOvertimeMinutes: number;
    totalLateMinutes: number;
  }[];
}

export interface CostReport {
  rows: {
    projectId?: number;
    projectName?: string;
    taskId?: number;
    taskName?: string;
    labelPath?: string;
    laborCost: number;
    expenseCost: number;
    totalCost: number;
    budgetAmount: number | null;
    variance: number | null;
  }[];
  totals: {
    laborCost: number;
    expenseCost: number;
    totalCost: number;
  };
}

export interface ActivityLog {
  id: number;
  userId: number | null;
  sessionId: string | null;
  category: string;
  action: string;
  severity: string;
  entityType: string | null;
  entityId: number | null;
  entityName: string | null;
  description: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
  };
}
