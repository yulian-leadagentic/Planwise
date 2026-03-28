import { useState } from 'react';
import { ChevronRight, ChevronDown, FolderOpen, Folder } from 'lucide-react';
import { useLabels } from '@/hooks/use-labels';
import { Label } from '@amec/shared';

interface ProjectTreeProps {
  projectId: number;
}

export function ProjectTree({ projectId }: ProjectTreeProps) {
  const { data, isLoading } = useLabels(projectId);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const labels: Label[] = data?.data || [];
  const rootLabels = labels.filter((l) => !l.parentId);

  if (rootLabels.length === 0) {
    return <p className="text-sm text-muted-foreground">No labels yet. Create your first label to organize this project.</p>;
  }

  return (
    <div className="space-y-1">
      {rootLabels.map((label) => (
        <TreeNode key={label.id} label={label} allLabels={labels} level={0} />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  label: Label;
  allLabels: Label[];
  level: number;
}

function TreeNode({ label, allLabels, level }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(level < 2);
  const children = allLabels.filter((l) => l.parentId === label.id);
  const hasChildren = children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1.5 px-2 rounded-md hover:bg-muted/50 cursor-pointer text-sm"
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={() => hasChildren && setIsOpen(!isOpen)}
      >
        {hasChildren ? (
          isOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {isOpen && hasChildren ? (
          <FolderOpen className="h-4 w-4 shrink-0" style={{ color: label.color || label.labelType?.color || '#6B7280' }} />
        ) : (
          <Folder className="h-4 w-4 shrink-0" style={{ color: label.color || label.labelType?.color || '#6B7280' }} />
        )}

        <span className="truncate">{label.name}</span>

        {label.labelType && (
          <span
            className="ml-auto text-xs px-1.5 py-0.5 rounded-full shrink-0"
            style={{ backgroundColor: label.labelType.color + '20', color: label.labelType.color }}
          >
            {label.labelType.name}
          </span>
        )}

        {label.taskCount !== undefined && label.taskCount > 0 && (
          <span className="text-xs text-muted-foreground shrink-0">{label.taskCount}</span>
        )}
      </div>

      {isOpen &&
        children
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((child) => (
            <TreeNode key={child.id} label={child} allLabels={allLabels} level={level + 1} />
          ))}
    </div>
  );
}
