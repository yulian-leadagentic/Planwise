import { Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { PrivateRoute } from './private-route';
import { RoutePermissionGuard } from './route-permission-guard';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/features/auth/login-page';
import { ForgotPasswordSteps } from '@/features/auth/forgot-password-steps';
import { DashboardPage } from '@/features/dashboard/dashboard-page';

// Lazy-load every other page so the initial bundle stays small
const ManagerDashboard = lazy(() => import('@/features/dashboard/manager-dashboard').then(m => ({ default: m.ManagerDashboard })));
const OperationsDashboardPage = lazy(() => import('@/features/dashboard/operations-dashboard').then(m => ({ default: m.OperationsDashboardPage })));
const WorkloadDashboardPage = lazy(() => import('@/features/dashboard/workload-dashboard').then(m => ({ default: m.WorkloadDashboardPage })));
const ExecutionBoardPage = lazy(() => import('@/features/execution-board/execution-board-page').then(m => ({ default: m.ExecutionBoardPage })));
const TasksPage = lazy(() => import('@/features/tasks/tasks-page').then(m => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import('@/features/tasks/task-detail-page').then(m => ({ default: m.TaskDetailPage })));
const MyTimePage = lazy(() => import('@/features/time/my-time-page').then(m => ({ default: m.MyTimePage })));
const WeeklyTimesheetPage = lazy(() => import('@/features/time/weekly-timesheet').then(m => ({ default: m.WeeklyTimesheetPage })));
const TimeGridPage = lazy(() => import('@/features/time/time-grid-page').then(m => ({ default: m.TimeGridPage })));
const ClockDashboardPage = lazy(() => import('@/features/time/clock-dashboard-page').then(m => ({ default: m.ClockDashboardPage })));
const ProjectListPage = lazy(() => import('@/features/projects/project-list-page').then(m => ({ default: m.ProjectListPage })));
const ProjectDetailPage = lazy(() => import('@/features/projects/project-detail-page').then(m => ({ default: m.ProjectDetailPage })));
const ProjectFormPage = lazy(() => import('@/features/projects/project-form-page').then(m => ({ default: m.ProjectFormPage })));
const ContractsPage = lazy(() => import('@/features/contracts/contracts-page').then(m => ({ default: m.ContractsPage })));
const PeoplePage = lazy(() => import('@/features/people/people-page').then(m => ({ default: m.PeoplePage })));
const PartnersPage = lazy(() => import('@/features/partners/partners-page').then(m => ({ default: m.PartnersPage })));
const ContactsPage = lazy(() => import('@/features/partners/contacts-page').then(m => ({ default: m.ContactsPage })));
const PartnerTypesPage = lazy(() => import('@/features/admin/partner-types-page').then(m => ({ default: m.PartnerTypesPage })));
const ReportsPage = lazy(() => import('@/features/reports/reports-page').then(m => ({ default: m.ReportsPage })));
const TimesheetReportPage = lazy(() => import('@/features/reports/timesheet-report-page').then(m => ({ default: m.TimesheetReportPage })));
const AttendanceReportPage = lazy(() => import('@/features/reports/attendance-report-page').then(m => ({ default: m.AttendanceReportPage })));
const CostReportPage = lazy(() => import('@/features/reports/cost-report-page').then(m => ({ default: m.CostReportPage })));
const OvertimeReportPage = lazy(() => import('@/features/reports/overtime-report-page').then(m => ({ default: m.OvertimeReportPage })));
const LateArrivalsPage = lazy(() => import('@/features/reports/late-arrivals-page').then(m => ({ default: m.LateArrivalsPage })));
const MilestonesPage = lazy(() => import('@/features/reports/milestones-page').then(m => ({ default: m.MilestonesPage })));
const BillingForecastPage = lazy(() => import('@/features/reports/billing-forecast-page').then(m => ({ default: m.BillingForecastPage })));
const TemplatesPage = lazy(() => import('@/features/templates/templates-page').then(m => ({ default: m.TemplatesPage })));
const TaskCatalogPage = lazy(() => import('@/features/templates/task-catalog-page').then(m => ({ default: m.TaskCatalogPage })));
const DeliverableTemplatesPage = lazy(() => import('@/features/templates/deliverable-templates-page').then(m => ({ default: m.DeliverableTemplatesPage })));
const ZoneTemplatesPage = lazy(() => import('@/features/templates/zone-templates-page').then(m => ({ default: m.ZoneTemplatesPage })));
const TeamTemplatesPage = lazy(() => import('@/features/templates/team-templates-page').then(m => ({ default: m.TeamTemplatesPage })));
const PhasesPage = lazy(() => import('@/features/templates/services-page').then(m => ({ default: m.PhasesPage })));
const TypesPage = lazy(() => import('@/features/templates/types-page').then(m => ({ default: m.TypesPage })));
const AdminPage = lazy(() => import('@/features/admin/admin-page').then(m => ({ default: m.AdminPage })));
const AdminLayout = lazy(() => import('@/features/admin/admin-layout').then(m => ({ default: m.AdminLayout })));
const TemplatesLayout = lazy(() => import('@/features/templates/templates-layout').then(m => ({ default: m.TemplatesLayout })));
const RolesPage = lazy(() => import('@/features/admin/roles-page').then(m => ({ default: m.RolesPage })));
const InboxPage = lazy(() => import('@/features/messaging/inbox-page').then(m => ({ default: m.InboxPage })));
const MessagingDashboardPage = lazy(() => import('@/features/messaging/messaging-dashboard-page').then(m => ({ default: m.MessagingDashboardPage })));
const MessageSearchPage = lazy(() => import('@/features/messaging/message-search-page').then(m => ({ default: m.MessageSearchPage })));
const NotificationSettingsPage = lazy(() => import('@/features/admin/notification-settings-page').then(m => ({ default: m.NotificationSettingsPage })));
const TimeNotePhrasesPage = lazy(() => import('@/features/admin/time-note-phrases-page').then(m => ({ default: m.TimeNotePhrasesPage })));
const ProjectTypesPage = lazy(() => import('@/features/admin/project-types-page').then(m => ({ default: m.ProjectTypesPage })));
const NumberRangesPage = lazy(() => import('@/features/admin/number-ranges-page').then(m => ({ default: m.NumberRangesPage })));
const ObjectNumberingPage = lazy(() => import('@/features/admin/object-numbering-page').then(m => ({ default: m.ObjectNumberingPage })));
const CurrenciesPage = lazy(() => import('@/features/admin/currencies-page').then(m => ({ default: m.CurrenciesPage })));
const SeniorityLevelsPage = lazy(() => import('@/features/admin/seniority-levels-page').then(m => ({ default: m.SeniorityLevelsPage })));
const ProjectRoleTypesPage = lazy(() => import('@/features/admin/project-role-types-page').then(m => ({ default: m.ProjectRoleTypesPage })));
const ActivityLogPage = lazy(() => import('@/features/admin/activity-log-page').then(m => ({ default: m.ActivityLogPage })));
const WorkSchedulesPage = lazy(() => import('@/features/admin/work-schedules-page').then(m => ({ default: m.WorkSchedulesPage })));
const CalendarDaysPage = lazy(() => import('@/features/admin/calendar-page').then(m => ({ default: m.CalendarDaysPage })));
const DataImportPage = lazy(() => import('@/features/data-import/data-import-page').then(m => ({ default: m.DataImportPage })));
const ImportHistoryPage = lazy(() => import('@/features/data-import/import-history-page').then(m => ({ default: m.ImportHistoryPage })));
const ProjectStatusBoardPage = lazy(() => import('@/features/project-status-board/project-status-board-page').then(m => ({ default: m.ProjectStatusBoardPage })));
const StageMilestonesPage = lazy(() => import('@/features/admin/stage-milestones-page').then(m => ({ default: m.StageMilestonesPage })));
const OrganizationPage = lazy(() => import('@/features/admin/organization-page').then(m => ({ default: m.OrganizationPage })));
const SsoPage = lazy(() => import('@/features/admin/sso-page').then(m => ({ default: m.SsoPage })));
const ProfilePage = lazy(() => import('@/features/misc/profile-page').then(m => ({ default: m.ProfilePage })));
const NotFoundPage = lazy(() => import('@/features/misc/not-found-page').then(m => ({ default: m.NotFoundPage })));

// DnD-heavy (kept lazy to avoid @dnd-kit React version conflicts)
const MyTasksKanbanPage = lazy(() => import('@/features/tasks/my-tasks-kanban').then(m => ({ default: m.MyTasksKanbanPage })));
const PlanningPage = lazy(() => import('@/features/projects/planning-modal').then(m => ({ default: m.PlanningPage })));

function LazyFallback() {
  return <div className="flex items-center justify-center py-20 text-sm text-slate-400 dark:text-slate-500">Loading...</div>;
}

function L({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LazyFallback />}>{children}</Suspense>;
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
            <RoutePermissionGuard>
              <AppShell />
            </RoutePermissionGuard>
          </PrivateRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="operations" element={<L><OperationsDashboardPage /></L>} />
        <Route path="dashboard/manager" element={<L><ManagerDashboard /></L>} />
        <Route path="dashboard/workload" element={<L><WorkloadDashboardPage /></L>} />
        <Route path="execution-board" element={<L><ExecutionBoardPage /></L>} />
        <Route path="status-board" element={<L><ProjectStatusBoardPage /></L>} />

        {/* Tasks */}
        <Route path="tasks" element={<L><TasksPage /></L>} />
        <Route path="my-tasks" element={<L><MyTasksKanbanPage /></L>} />
        <Route path="tasks/:id" element={<L><TaskDetailPage /></L>} />

        {/* Messaging / Time */}
        <Route path="inbox" element={<L><InboxPage /></L>} />
        <Route path="messages/dashboard" element={<L><MessagingDashboardPage /></L>} />
        <Route path="messages/search" element={<L><MessageSearchPage /></L>} />
        <Route path="time" element={<L><WeeklyTimesheetPage /></L>} />
        <Route path="time/summary" element={<L><MyTimePage /></L>} />
        <Route path="time/grid" element={<L><TimeGridPage /></L>} />
        <Route path="time/clock-dashboard" element={<L><ClockDashboardPage /></L>} />

        {/* Projects */}
        <Route path="projects" element={<L><ProjectListPage /></L>} />
        <Route path="projects/new" element={<L><ProjectFormPage /></L>} />
        <Route path="projects/:id" element={<L><ProjectDetailPage /></L>} />
        <Route path="projects/:id/edit" element={<L><ProjectFormPage /></L>} />
        <Route path="projects/:id/planning" element={<L><PlanningPage /></L>} />

        {/* Contracts */}
        <Route path="contracts" element={<L><ContractsPage /></L>} />

        {/* Employees (internal staff with login accounts) — the primary
            route lives inside the nested admin block below as
            /admin/employees. /people stays as an alias for
            backwards-compat / bookmarks. */}
        <Route path="people" element={<L><PeoplePage /></L>} />
        <Route path="partners" element={<L><PartnersPage /></L>} />
        <Route path="contacts" element={<L><ContactsPage /></L>} />

        {/* Reports */}
        <Route path="reports" element={<L><ReportsPage /></L>} />
        <Route path="reports/timesheet" element={<L><TimesheetReportPage /></L>} />
        <Route path="reports/attendance" element={<L><AttendanceReportPage /></L>} />
        <Route path="reports/cost" element={<L><CostReportPage /></L>} />
        <Route path="reports/overtime" element={<L><OvertimeReportPage /></L>} />
        <Route path="reports/late-arrivals" element={<L><LateArrivalsPage /></L>} />
        <Route path="reports/milestones" element={<L><MilestonesPage /></L>} />
        <Route path="reports/billing-forecast" element={<L><BillingForecastPage /></L>} />

        {/* Templates — nested under TemplatesLayout so every sub-page
            renders alongside a persistent sub-nav (Fix 2). URLs
            unchanged: the layout owns `/templates/*` and each child
            uses a relative path. `index` handles the hub page. */}
        <Route path="templates" element={<L><TemplatesLayout /></L>}>
          <Route index element={<L><TemplatesPage /></L>} />
          <Route path="task-catalog" element={<L><TaskCatalogPage /></L>} />
          <Route path="deliverables" element={<L><DeliverableTemplatesPage /></L>} />
          <Route path="zone" element={<L><ZoneTemplatesPage /></L>} />
          <Route path="team" element={<L><TeamTemplatesPage /></L>} />
          <Route path="services" element={<L><PhasesPage /></L>} />
          <Route path="types" element={<L><TypesPage /></L>} />
          <Route path="project-types" element={<L><ProjectTypesPage /></L>} />
        </Route>

        {/* Admin — same nested pattern as Templates, hub stays as the
            index so /admin still renders the overview cards. */}
        <Route path="admin" element={<L><AdminLayout /></L>}>
          <Route index element={<L><AdminPage /></L>} />
          <Route path="roles" element={<L><RolesPage /></L>} />
          <Route path="activity-log" element={<L><ActivityLogPage /></L>} />
          <Route path="work-schedules" element={<L><WorkSchedulesPage /></L>} />
          <Route path="calendar" element={<L><CalendarDaysPage /></L>} />
          <Route path="notification-settings" element={<L><NotificationSettingsPage /></L>} />
          <Route path="time-note-phrases" element={<L><TimeNotePhrasesPage /></L>} />
          <Route path="clock-dashboard" element={<L><ClockDashboardPage /></L>} />
          <Route path="partner-types" element={<L><PartnerTypesPage /></L>} />
          <Route path="number-ranges" element={<L><NumberRangesPage /></L>} />
          <Route path="object-numbering" element={<L><ObjectNumberingPage /></L>} />
          <Route path="currencies" element={<L><CurrenciesPage /></L>} />
          <Route path="seniority-levels" element={<L><SeniorityLevelsPage /></L>} />
          <Route path="project-role-types" element={<L><ProjectRoleTypesPage /></L>} />
          <Route path="data-import" element={<L><DataImportPage /></L>} />
          <Route path="data-import/history" element={<L><ImportHistoryPage /></L>} />
          <Route path="project-stage-milestones" element={<L><StageMilestonesPage /></L>} />
          <Route path="organization" element={<L><OrganizationPage /></L>} />
          <Route path="sso" element={<L><SsoPage /></L>} />
          <Route path="employees" element={<L><PeoplePage /></L>} />
        </Route>

        {/* Account */}
        <Route path="profile" element={<L><ProfilePage /></L>} />

        {/* Authenticated catch-all — render a real 404 inside the shell so the
            user keeps navigation, instead of silently redirecting to "/". */}
        <Route path="*" element={<L><NotFoundPage /></L>} />
      </Route>
    </Routes>
  );
}
