import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';

export function TeamTemplatesPage() {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent"><ArrowLeft className="h-5 w-5" /></button>
        <PageHeader title="Team Templates" description="Reusable team compositions for projects" />
      </div>
      <div className="rounded-lg border border-border bg-background p-8 text-center">
        <Users className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-medium">No team templates</h3>
        <p className="mt-1 text-sm text-muted-foreground">Team templates let you save and reuse team compositions across projects.</p>
      </div>
    </div>
  );
}
