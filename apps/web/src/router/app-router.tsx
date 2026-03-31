import { Routes, Route, Navigate } from 'react-router-dom';
import { PrivateRoute } from './private-route';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/features/auth/login-page';
import { ForgotPasswordSteps } from '@/features/auth/forgot-password-steps';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { TasksPage } from '@/features/tasks/tasks-page';
import { TaskDetailPage } from '@/features/tasks/task-detail-page';
import { MyTimePage } from '@/features/time/my-time-page';
import { TimeGridPage } from '@/features/time/time-grid-page';
import { ClockDashboardPage } from '@/features/time/clock-dashboard-page';
import { ProjectListPage } from '@/features/projects/project-list-page';
import { ProjectDetailPage } from '@/features/projects/project-detail-page';
import { ProjectFormPage } from '@/features/projects/project-form-page';
import { PlanningPage } from '@/features/projects/planning-modal';
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
import { CategoriesPage } from '@/features/templates/categories-page';
import { PhasesPage } from '@/features/templates/phases-page';
import { AdminPage } from '@/features/admin/admin-page';
import { RolesPage } from '@/features/admin/roles-page';
import { ProjectTypesPage } from '@/features/admin/project-types-page';
import { ActivityLogPage } from '@/features/admin/activity-log-page';
import { WorkSchedulesPage } from '@/features/admin/work-schedules-page';
import { CalendarDaysPage } from '@/features/admin/calendar-page';

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

        {/* Tasks */}
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:id" element={<TaskDetailPage />} />

        {/* Time */}
        <Route path="time" element={<MyTimePage />} />
        <Route path="time/grid" element={<TimeGridPage />} />
        <Route path="time/clock-dashboard" element={<ClockDashboardPage />} />

        {/* Projects */}
        <Route path="projects" element={<ProjectListPage />} />
        <Route path="projects/new" element={<ProjectFormPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/edit" element={<ProjectFormPage />} />
        <Route path="projects/:id/planning" element={<PlanningPage />} />

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
        <Route path="templates/categories" element={<CategoriesPage />} />
        <Route path="templates/phases" element={<PhasesPage />} />
        <Route path="templates/project-types" element={<ProjectTypesPage />} />

        {/* Admin */}
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/roles" element={<RolesPage />} />
        <Route path="admin/activity-log" element={<ActivityLogPage />} />
        <Route path="admin/work-schedules" element={<WorkSchedulesPage />} />
        <Route path="admin/calendar" element={<CalendarDaysPage />} />
        <Route path="admin/clock-dashboard" element={<ClockDashboardPage />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
