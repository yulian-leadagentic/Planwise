import { Routes, Route, Navigate } from 'react-router-dom';
import { PrivateRoute } from './private-route';
import { RoleRoute } from './role-route';
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
import { ContractsPage } from '@/features/contracts/contracts-page';
import { PeoplePage } from '@/features/people/people-page';
import { ReportsPage } from '@/features/reports/reports-page';
import { TemplatesPage } from '@/features/templates/templates-page';
import { AdminPage } from '@/features/admin/admin-page';

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
        <Route
          path="time/clock-dashboard"
          element={
            <RoleRoute roles={['admin', 'manager']}>
              <ClockDashboardPage />
            </RoleRoute>
          }
        />

        {/* Projects */}
        <Route path="projects" element={<ProjectListPage />} />
        <Route path="projects/new" element={<ProjectFormPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/edit" element={<ProjectFormPage />} />

        {/* Contracts */}
        <Route path="contracts" element={<ContractsPage />} />

        {/* People */}
        <Route path="people" element={<PeoplePage />} />

        {/* Reports */}
        <Route
          path="reports/*"
          element={
            <RoleRoute roles={['admin', 'manager']}>
              <ReportsPage />
            </RoleRoute>
          }
        />

        {/* Templates */}
        <Route
          path="templates"
          element={
            <RoleRoute roles={['admin', 'manager']}>
              <TemplatesPage />
            </RoleRoute>
          }
        />

        {/* Admin */}
        <Route
          path="admin/*"
          element={
            <RoleRoute roles={['admin']}>
              <AdminPage />
            </RoleRoute>
          }
        />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
