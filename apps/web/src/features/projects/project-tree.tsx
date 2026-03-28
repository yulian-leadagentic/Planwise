import { useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Folder, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Label } from '@/types';

interface ProjectTreeProps {
  labels: Label[];
}

export function ProjectTree({ labels }: ProjectTreeProps) {
  return (
    <div className="space-y-1">
      {labels.map((label) => (
        <TreeNode key={label.id} label={label} depth={0} />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  label: Label;
  depth: number;
}

function TreeNode({ label, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = label.children && label.children.length > 0;

  return (
    <div>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50',
          hasChildren && 'cursor-pointer',
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand/collapse icon */}
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-4" />
        )}

        {/* Folder/file icon */}
        {hasChildren ? (
          expanded ? (
            <FolderOpen
              className="h-4 w-4 shrink-0"
              style={{ color: label.color || label.labelType?.color || '#3b82f6' }}
            />
          ) : (
            <Folder
              className="h-4 w-4 shrink-0"
              style={{ color: label.color || label.labelType?.color || '#3b82f6' }}
            />
          )
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {/* Label color dot */}
        {label.color && (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: label.color }}
          />
        )}

        {/* Label name */}
        <span className="flex-1 truncate text-left font-medium">{label.name}</span>

        {/* Label type */}
        {label.labelType && (
          <span
            className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-xs"
            style={{
              backgroundColor: label.labelType.color + '20',
              color: label.labelType.color,
            }}
          >
            {label.labelType.name}
          </span>
        )}

        {/* Task count */}
        {label.taskCount != null && label.taskCount > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {label.taskCount} task{label.taskCount !== 1 ? 's' : ''}
          </span>
        )}
      </button>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {label
            .children!.sort((a, b) => a.sortOrder - b.sortOrder)
            .map((child) => (
              <TreeNode key={child.id} label={child} depth={depth + 1} />
            ))}
        </div>
      )}
    </div>
  );
}
