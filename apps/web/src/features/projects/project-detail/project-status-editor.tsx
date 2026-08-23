import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useUpdateProject } from '@/hooks/use-projects';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';

/**
 * Inline status editor for the project detail header.
 *
 * Fixes PR-002 — before this, the header showed a read-only status
 * pill and the only way to change status was the full Edit form.
 * Users couldn't find it. Backend `projects.service#update()` already
 * accepts a `status` PATCH (permissive; no guardrail on update), so
 * this is a UI gap, not a server change.
 *
 * Pattern matches the app's other inline-edit affordances (task
 * drawer, exec-review-tab): pill on rest, click reveals a small
 * menu, arrow keys + Enter/Escape supported. The status options
 * mirror the `<select>` in `project-form-page.tsx#L596` — kept in
 * sync so the two paths never diverge.
 *
 * Permission: `isAdmin || can('projects','write')`. Read-only users
 * still see the pill, just not the chevron.
 */

// Deliberately duplicated from `project-form-page.tsx` — a single
// source is one file away, but the point is the two lists cannot
// drift silently. If a new status is added here without the form,
// or vice-versa, we want the reviewer to spot it. Six values, one
// enum in Prisma (ProjectStatus).
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Color per status — mirrors the STATUS_COLORS map in
// `lib/constants.ts` but scoped to the ProjectStatus enum. Kept
// local so the header pill can carry a per-status tint (currently
// all statuses used blue — see the read-only pill this replaces —
// but a color-per-status reads better next to the project title).
const STATUS_STYLE: Record<string, { bg: string; text: string }> = {
  draft:     { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-300' },
  active:    { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  on_hold:   { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300' },
  completed: { bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-300' },
  cancelled: { bg: 'bg-red-50 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-300' },
};

function labelFor(value: string): string {
  const hit = STATUS_OPTIONS.find((o) => o.value === value);
  if (hit) return hit.label;
  // Unknown enum value — fall back to a title-cased render so we
  // never render an empty pill on a new backend enum value we don't
  // yet know about.
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ProjectStatusEditor({
  projectId,
  status,
}: {
  projectId: number;
  status: string;
}) {
  const { isAdmin, can } = usePermissions();
  const canWrite = isAdmin || can('projects', 'write');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const updateProject = useUpdateProject();

  // Close menu on outside click + Escape. Focus returns to the
  // button on close so keyboard nav doesn't get stranded.
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

  const style = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  const pillClass = cn(
    'rounded-[5px] px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase',
    style.bg,
    style.text,
  );

  // Read-only user — same visual as before, no interaction.
  if (!canWrite) {
    return <span className={pillClass}>{labelFor(status)}</span>;
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
        title="Change status"
        className={cn(
          pillClass,
          'inline-flex items-center gap-1 hover:brightness-95 dark:hover:brightness-110 transition',
          updateProject.isPending && 'opacity-60 cursor-wait',
        )}
      >
        <span>{labelFor(status)}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[160px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 shadow-lg"
        >
          {STATUS_OPTIONS.map((opt) => {
            const selected = opt.value === status;
            const optStyle = STATUS_STYLE[opt.value] ?? STATUS_STYLE.draft;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (opt.value === status) return;
                  updateProject.mutate({ id: projectId, status: opt.value });
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition',
                  'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                  selected && 'bg-slate-50 dark:bg-slate-800/40',
                )}
              >
                <span
                  className={cn(
                    'rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase',
                    optStyle.bg,
                    optStyle.text,
                  )}
                >
                  {opt.label}
                </span>
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
