import { Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { usePermissions } from '@/hooks/use-permissions';

export function BillingForecastPage() {
  // Defense-in-depth: the route guard already maps '/reports/billing-forecast'
  // → 'finance', but this in-page check is the belt-and-suspenders against a
  // future map edit re-opening the leak. Even though this page is currently a
  // placeholder, it will grow to show ₪ figures — gate it now.
  // (FG-1, finance-gate-cost-report.md, 2026-09-28.)
  const { can } = usePermissions();
  if (!can('finance', 'read')) return <Navigate to="/reports" replace />;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing Forecast" description="Upcoming billings and revenue projections" />
      <p className="py-8 text-center text-sm text-muted-foreground">
        Billing forecast will show upcoming invoice amounts based on contract milestones and
        time-and-materials billing. Create contracts to see projections here.
      </p>
    </div>
  );
}
