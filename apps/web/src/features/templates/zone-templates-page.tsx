import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Layers } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';

export function ZoneTemplatesPage() {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/templates')} className="rounded-md p-1.5 hover:bg-accent"><ArrowLeft className="h-5 w-5" /></button>
        <PageHeader title="Zone Templates" description="Reusable zone structures for projects" />
      </div>
      <div className="rounded-lg border border-border bg-background p-8 text-center">
        <Layers className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-medium">No zone templates</h3>
        <p className="mt-1 text-sm text-muted-foreground">Zone templates will allow you to save and reuse zone structures across projects.</p>
      </div>
    </div>
  );
}
