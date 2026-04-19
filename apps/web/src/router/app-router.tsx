import { Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { PrivateRoute } from './private-route';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/features/auth/login-page';
import { ForgotPasswordSteps } from '@/features/auth/forgot-password-steps';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { ManagerDashboard } from '@/features/dashboard/manager-dashboard';
import { OperationsDashboardPage } from '@/features/dashboard/operations-dashboard';
import { WorkloadDashboardPage } from '@/features/dashboard/workload-dashboard';
import { ExecutionBoardPage } from '@/features/execution-board/execution-board-page';
import { TasksPage } from '@/features/tasks/tasks-page';
import { TaskDetailPage } from '@/features/tasks/task-detail-page';
import { MyTimePage } from '@/features/time/my-time-page';
import { WeeklyTimesheetPage } from '@/features/time/weekly-timesheet';
import { TimeGridPage } from '@/features/time/time-grid-page';
import { ClockDashboardPage } from '@/features/time/clock-dashboard-page';
import { ProjectListPage } from '@/features/projects/project-list-page';
import { ProjectDetailPage } from '@/features/projects/project-detail-page';
import { ProjectFormPage } from '@/features/projects/project-form-page';
import { ContractsPage } from '@/features/contracts/contracts-page';
import { PeoplePage } from '@/features/people/people-page';
import { ReportsPage } from '@/features/reports/reports-page';
import { TimesheetReportPage } from '@/features/reports/timesheet-report-page';
import { AttendanceReportPage } from '@/features/reports/attendance-report-page';
import { CostReportPage } from '@/features/reports/cost-report-page';
import { OvertimeReportPage } from '@/features/reports/overtime-report-page';
import { LateArrivalsPage } from '@/features/reports/late-arrivals-page';
import { MilestonesPage } from '@/features/reports/milestones-page';
import { BillingForecastPage } from '@/features/reports/billing-forecast-page';
import { TemplatesPage } from '@/features/templates/templates-page';
import { TaskCatalogPage } from '@/features/templates/task-catalog-page';
import { ServiceTemplatesPage } from '@/features/templates/phase-templates-page';
import { ZoneTemplatesPage } from '@/features/templates/zone-templates-page';
import { TeamTemplatesPage } from '@/features/templates/team-templates-page';
import { PhasesPage } from '@/features/templates/services-page';
import { TypesPage } from '@/features/templates/types-page';
import { AdminPage } from '@/features/admin/admin-page';
import { RolesPage } from '@/features/admin/roles-page';
import { InboxPage } from '@/features/messaging/inbox-page';
import { MessagingDashboardPage } from '@/features/messaging/messaging-dashboard-page';
import { MessageSearchPage } from '@/features/messaging/message-search-page';
import { NotificationSettingsPage } from '@/features/admin/notification-settings-page';
import { ProjectTypesPage } from '@/features/admin/project-types-page';
import { ActivityLogPage } from '@/features/admin/activity-log-page';
import { WorkSchedulesPage } from '@/features/admin/work-schedules-page';
import { CalendarDaysPage } from '@/features/admin/calendar-page';

// Lazy-load DnD-heavy components to avoid @dnd-kit React version conflicts
const MyTasksKanbanPage = lazy(() => import('@/features/tasks/my-tasks-kanban').then(m => ({ default: m.MyTasksKanbanPage })));
const PlanningPage = lazy(() => import('@/features/projects/planning-modal').then(m => ({ default: m.PlanningPage })));

function LazyFallback() {
  return <div className="flex items-center justify-center py-20 text-sm text-slate-400">Loading...</div>;
}

export function AppRouter() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordSteps />} />

      {/* Protected routes */}
      <Route
        element={
          <PrivateRoute>
            <AppShell />
          </PrivateRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="operations" element={<OperationsDashboardPage />} />
        <Route path="dashboard/manager" element={<ManagerDashboard />} />
        <Route path="dashboard/workload" element={<WorkloadDashboardPage />} />
        <Route path="execution-board" element={<ExecutionBoardPage />} />

        {/* Tasks */}
        <Route path="tasks" element={<TasksPage />} />
        <Route path="my-tasks" element={<Suspense fallback={<LazyFallback />}><MyTasksKanbanPage /></Suspense>} />
        <Route path="tasks/:id" element={<TaskDetailPage />} />

        {/* Time */}
        <Route path="inbox" element={<InboxPage />} />
        <Route path="messages/dashboard" element={<MessagingDashboardPage />} />
        <Route path="messages/search" element={<MessageSearchPage />} />
        <Route path="time" element={<WeeklyTimesheetPage />} />
        <Route path="time/summary" element={<MyTimePage />} />
        <Route path="time/grid" element={<TimeGridPage />} />
        <Route path="time/clock-dashboard" element={<ClockDashboardPage />} />

        {/* Projects */}
        <Route path="projects" element={<ProjectListPage />} />
        <Route path="projects/new" element={<ProjectFormPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="projects/:id/planning" element={<Suspense fallback={<LazyFallback />}><PlanningPage /></Suspense>} />

        {/* Contracts */}
        <Route path="contracts" element={<ContractsPage />} />

        {/* People */}
        <Route path="people" element={<PeoplePage />} />

        {/* Reports */}
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reports/timesheet" element={<TimesheetReportPage />} />
        <Route path="reports/attendance" element={<AttendanceReportPage />} />
        <Route path="reports/cost" element={<CostReportPage />} />
        <Route path="reports/overtime" element={<OvertimeReportPage />} />
        <Route path="reports/late-arrivals" element={<LateArrivalsPage />} />
        <Route path="reports/milestones" element={<MilestonesPage />} />
        <Route path="reports/billing-forecast" element={<BillingForecastPage />} />

        {/* Templates */}
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/task-catalog" element={<TaskCatalogPage />} />
        <Route path="templates/phases" element={<ServiceTemplatesPage />} />
        <Route path="templates/zone" element={<ZoneTemplatesPage />} />
        <Route path="templates/team" element={<TeamTemplatesPage />} />
        <Route path="templates/services" element={<PhasesPage />} />
        <Route path="templates/types" element={<TypesPage />} />
        <Route path="templates/project-types" element={<ProjectTypesPage />} />

        {/* Admin */}
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/roles" element={<RolesPage />} />
        <Route path="admin/activity-log" element={<ActivityLogPage />} />
        <Route path="admin/work-schedules" element={<WorkSchedulesPage />} />
        <Route path="admin/calendar" element={<CalendarDaysPage />} />
        <Route path="admin/notification-settings" element={<NotificationSettingsPage />} />
        <Route path="admin/clock-dashboard" element={<ClockDashboardPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
