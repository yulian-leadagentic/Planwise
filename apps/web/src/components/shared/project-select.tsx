import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X, FolderKanban } from 'lucide-react';
import { useProjects } from '@/hooks/use-projects';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';

interface ProjectSelectProps {
  value?: number | null;
  onChange: (projectId: number | null) => void;
  placeholder?: string;
  className?: string;
}

export function ProjectSelect({
  value,
  onChange,
  placeholder = 'Select project',
  className,
}: ProjectSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useProjects({ search: debouncedSearch, perPage: 50 });
  const projects = data?.data ?? [];

  const selected = projects.find((p) => p.id === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
      >
        <FolderKanban className="h-4 w-4 text-muted-foreground" />
        {selected ? (
          <span>{selected.name}</span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {value && (
            <X
              className="h-4 w-4 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </div>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {projects.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No projects found</p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    onChange(project.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent',
                    project.id === value && 'bg-accent',
                  )}
                >
                  <span>{project.name}</span>
                  {project.number && (
                    <span className="text-xs text-muted-foreground">({project.number})</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
