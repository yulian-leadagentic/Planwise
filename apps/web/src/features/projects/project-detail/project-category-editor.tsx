import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Star, Tag } from 'lucide-react';
import { useProjectTypes, useUpdateProject } from '@/hooks/use-projects';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import type { ProjectType } from '@/types';

/**
 * Inline category (project-type) editor for the project detail header.
 *
 * QA3 Wave-1 Commit 3C-b: multi-select chip editor. Displays one pill
 * per linked category (primary first, marked with a Primary badge);
 * clicking opens a menu of the full catalog with checkboxes — first
 * checked is primary. Backend accepts `projectTypeIds` on PATCH via
 * `UpdateProjectDto extends PartialType(CreateProjectDto)`; the service
 * derives primary from `projectTypeIds[0]` and rewrites the junction.
 *
 * Sources: `projectType` (primary from `projects.service#findOne`) plus
 * `categoryLinks` (junction rows) when the API included them. Legacy
 * responses without `categoryLinks` fall back to the primary FK alone.
 */

export function ProjectCategoryEditor({
  projectId,
  projectType,
  categoryLinks = [],
}: {
  projectId: number;
  projectType: { id: number; name: string; color: string | null } | null;
  categoryLinks?: Array<{
    projectTypeId: number;
    projectType: { id: number; name: string; color: string | null };
  }>;
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

  // Effective list of chips — primary first, extras next, deduped.
  const displayed = useMemo(() => {
    const out: Array<{ id: number; name: string; color: string | null; isPrimary: boolean }> = [];
    const seen = new Set<number>();
    if (projectType?.id) {
      seen.add(projectType.id);
      out.push({
        id: projectType.id,
        name: projectType.name,
        color: projectType.color,
        isPrimary: true,
      });
    }
    for (const l of categoryLinks) {
      const t = l?.projectType;
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ id: t.id, name: t.name, color: t.color, isPrimary: false });
    }
    return out;
  }, [projectType, categoryLinks]);

  const selectedIds = useMemo(() => displayed.map((d) => d.id), [displayed]);

  const patchIds = (nextIds: number[]) => {
    if (nextIds.length === 0) return; // primary must exist
    updateProject.mutate({ id: projectId, projectTypeIds: nextIds });
  };

  // Read-only user — same chip row without the ChevronDown affordance.
  if (!canWrite) {
    return (
      <div className="inline-flex items-center gap-1 flex-wrap">
        {displayed.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            <Tag className="h-3 w-3 opacity-70" aria-hidden />
            <span>No category</span>
          </span>
        ) : (
          displayed.map((d) => (
            <Chip key={d.id} name={d.name} color={d.color} isPrimary={d.isPrimary} />
          ))
        )}
      </div>
    );
  }

  return (
    <div className="relative inline-flex items-center gap-1 flex-wrap">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={updateProject.isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change categories"
        className={cn(
          'inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300',
          'hover:bg-slate-100 dark:hover:bg-slate-800 transition',
          updateProject.isPending && 'opacity-60 cursor-wait',
        )}
      >
        {displayed.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
            <Tag className="h-3 w-3 opacity-70" aria-hidden />
            <span>No category</span>
          </span>
        ) : (
          displayed.map((d) => (
            <Chip key={d.id} name={d.name} color={d.color} isPrimary={d.isPrimary} />
          ))
        )}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[260px] max-h-[320px] overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 shadow-lg"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Categories — first checked = primary
          </div>
          {(projectTypes ?? []).length === 0 && (
            <div className="px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400">
              No categories configured
            </div>
          )}
          {((projectTypes ?? []) as ProjectType[]).map((t) => {
            const selected = selectedIds.includes(t.id);
            const isPrimary = selectedIds[0] === t.id;
            const color = normalizeColor(t.color);
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={selected}
                  onClick={() => {
                    const next = selected
                      ? selectedIds.filter((x) => x !== t.id)
                      : [...selectedIds, t.id];
                    patchIds(next);
                  }}
                  className="flex flex-1 items-center gap-2 text-left text-[13px]"
                >
                  <span
                    className={cn(
                      'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                      selected
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900',
                    )}
                  >
                    {selected && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border border-slate-200 dark:border-slate-700"
                    style={color ? { backgroundColor: color } : { backgroundColor: '#E2E8F0' }}
                  />
                  <span className="truncate text-slate-700 dark:text-slate-200">{t.name}</span>
                </button>
                {selected && !isPrimary && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = [t.id, ...selectedIds.filter((x) => x !== t.id)];
                      patchIds(next);
                    }}
                    title="Make primary"
                    className="rounded p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/40"
                  >
                    <Star className="h-3 w-3" />
                  </button>
                )}
                {isPrimary && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded bg-blue-600 text-white px-1 py-[1px] text-[9px] font-bold tracking-wide uppercase"
                    title="Primary category — used for rollups"
                  >
                    <Star className="h-2.5 w-2.5 fill-white" />
                    Primary
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({
  name,
  color,
  isPrimary,
}: {
  name: string;
  color: string | null;
  isPrimary: boolean;
}) {
  const hex = normalizeColor(color);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold',
        isPrimary
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800'
          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700',
      )}
      title={isPrimary ? `${name} — primary` : name}
    >
      {hex && (
        <span
          className="h-2 w-2 rounded-full border border-slate-200 dark:border-slate-700"
          style={{ backgroundColor: hex }}
        />
      )}
      <Tag className="h-3 w-3 opacity-70" aria-hidden />
      <span className="truncate max-w-[140px]">{name}</span>
      {isPrimary && (
        <Star className="h-2.5 w-2.5 fill-current opacity-80" aria-hidden />
      )}
    </span>
  );
}

// Backend stores color as either `#RRGGBB` or the raw hex without
// the leading `#` (both shapes appear in seed data). Normalize so
// inline `style` never receives an invalid value.
function normalizeColor(color: string | null | undefined): string | null {
  if (!color) return null;
  return color.startsWith('#') ? color : `#${color}`;
}
