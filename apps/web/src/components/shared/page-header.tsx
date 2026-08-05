import { cn } from '@/lib/utils';

interface PageHeaderProps {
  // Widened from string → ReactNode so callers can render an inline
  // EditableText / breadcrumb / badge combo in the title slot. When
  // a plain string is passed it still lands inside the h1 exactly
  // as before, so no visual change for existing pages.
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
