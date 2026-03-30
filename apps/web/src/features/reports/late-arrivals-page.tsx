import { PageHeader } from '@/components/shared/page-header';

export function LateArrivalsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Late Arrivals" description="Employees who clocked in late" />
      <p className="py-8 text-center text-sm text-muted-foreground">
        Late arrivals report will show employees who clocked in after their scheduled shift start.
        This requires clock-in data to be populated first.
      </p>
    </div>
  );
}
