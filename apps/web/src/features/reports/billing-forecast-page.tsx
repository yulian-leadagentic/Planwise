import { PageHeader } from '@/components/shared/page-header';

export function BillingForecastPage() {
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
