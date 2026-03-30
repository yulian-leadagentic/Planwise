import { PageHeader } from '@/components/shared/page-header';

export function MilestonesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Milestones" description="Milestone progress and upcoming deadlines" />
      <p className="py-8 text-center text-sm text-muted-foreground">
        Milestone tracking will show progress against contract milestones and upcoming deadlines.
        Create contracts with milestones to see data here.
      </p>
    </div>
  );
}
