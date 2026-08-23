import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Tag } from 'lucide-react';
import { useProjectTypes, useUpdateProject } from '@/hooks/use-projects';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import type { ProjectType } from '@/types';

/**
 * Inline category (project-type) editor for the project detail header.
 *
 * Fixes PR-003 — "where do I set/change project category?". The
 * Category field lived only on the create/edit form
 * (`project-form-page.tsx#L500`). Surfacing it inline in the header
 * gives users an obvious control without the round-trip through the
 * full Edit page. Backend accepts `projectTypeId` on PATCH via
 * `UpdateProjectDto extends PartialType(CreateProjectDto)` — no
 * server change needed.
 *
 * Pattern matches `ProjectStatusEditor`: pill on rest, click opens
 * a small menu of options with the type's color chip. Read-only
 * users see the pill without the chevron.
 *
 * Options come from `useProjectTypes()` (already cached for 30 min
 * elsewhere; same query key). While the list is loading we still
 * render the current type name from the eager-loaded
 * `project.projectType` on the detail response.
 */

export function ProjectCategoryEditor({
  projectId,
  projectType,
}: {
  projectId: number;
  // The eager-loaded object from the project detail response —
  // `project.projectType` from `projects.service#findOne` includes it.
  // Shape matches the shared `ProjectType` type but color/id may be
  // absent on legacy projects.
  projectType: { id: number; name: string; color: string | null } | null;
}) {
  const { isAdmin, can } = usePermissions();
  const canWrite = isAdmin || can('projects', 'write');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { data: projectTypes } = useProjectTypes();
  const updateProject = useUpdateProject();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentName = projectType?.name ?? 'No category';
  const currentColor = normalizeColor(projectType?.color ?? null);

  // Read-only user: unclickable pill, same look as the writer's pill
  // but without the chevron.
  if (!canWrite) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
        {currentColor && (
          <span
            className="h-2 w-2 rounded-full border border-slate-200 dark:border-slate-700"
            style={{ backgroundColor: currentColor }}
          />
        )}
        <Tag className="h-3 w-3 opacity-70" aria-hidden />
        <span>{currentName}</span>
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={updateProject.isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change category"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300',
          'hover:bg-slate-200 dark:hover:bg-slate-700 transition',
          updateProject.isPending && 'opacity-60 cursor-wait',
        )}
      >
        {currentColor && (
          <span
            className="h-2 w-2 rounded-full border border-slate-200 dark:border-slate-700"
            style={{ backgroundColor: currentColor }}
          />
        )}
        <Tag className="h-3 w-3 opacity-70" aria-hidden />
        <span>{currentName}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[220px] max-h-[300px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 shadow-lg"
        >
          {(projectTypes ?? []).length === 0 && (
            <div className="px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400">
              No categories configured
            </div>
          )}
          {((projectTypes ?? []) as ProjectType[]).map((t) => {
            const selected = t.id === projectType?.id;
            const color = normalizeColor(t.color);
            return (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (t.id === projectType?.id) return;
                  updateProject.mutate({ id: projectId, projectTypeId: t.id });
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition',
                  'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                  selected && 'bg-slate-50 dark:bg-slate-800/40',
                )}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-slate-200 dark:border-slate-700"
                  style={color ? { backgroundColor: color } : { backgroundColor: '#E2E8F0' }}
                />
                <span className="truncate text-slate-700 dark:text-slate-200">{t.name}</span>
                {selected && (
                  <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">Current</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Backend stores color as either `#RRGGBB` or the raw hex without
// the leading `#` (both shapes appear in seed data). Normalize so
// inline `style` never receives an invalid value.
function normalizeColor(color: string | null | undefined): string | null {
  if (!color) return null;
  return color.startsWith('#') ? color : `#${color}`;
}
