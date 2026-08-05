import { useNavigate } from 'react-router-dom';
import { ChevronDown, Check } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useProjects } from '@/hooks/use-projects';
import { cn } from '@/lib/utils';

/**
 * Prev / Next controls between the projects the current user can see.
 * The list comes from the same /projects endpoint that powers the
 * Projects list, so access-controlled filtering is applied server-side
 * — no accidental navigation into projects the user isn't a member of.
 * (Client feedback 2026-08-02.)
 */
/**
 * Project picker — searchable dropdown of every project the user can
 * see. Replaces the old Prev/Next arrow pair per client feedback
 * (2026-08-02 item 1). Type to filter, click to navigate. Shows the
 * current project as the trigger label; the popover flags it with a
 * checkmark so users know where they are in the list.
 */
export function ProjectPrevNext({ currentId }: { currentId: number }) {
  const navigate = useNavigate();
  const { data } = useProjects({ perPage: 500 });
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else setSearch('');
  }, [open]);

  if (list.length <= 1) return null;

  const current = list.find((p) => p.id === currentId);
  const filtered = search.trim()
    ? list.filter((p) => {
        const q = search.trim().toLowerCase();
        return (
          (p.name ?? '').toLowerCase().includes(q) ||
          (p.number ?? '').toLowerCase().includes(q)
        );
      })
    : list;

  return (
    <div ref={wrapRef} className="relative ml-2 pl-2 border-l border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        dir="ltr"
        className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-[12px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 min-w-[220px] max-w-[320px]"
        title="Switch project"
      >
        {/* Name in its own slot so a Hebrew name doesn't collide with
            the LTR project number. `dir="ltr"` on the outer button
            keeps the CHEVRON and NUMBER on the right regardless of
            the surrounding page direction; the name still renders
            RTL if its own characters demand it. */}
        <span className="truncate text-left flex-1">{current?.name ?? 'Select project'}</span>
        {current?.number && (
          <span className="shrink-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono text-[10px] px-1.5 py-0.5">
            {current.number}
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 dark:text-slate-500 transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-2 top-full mt-1 z-40 w-[320px] rounded-xl bg-white dark:bg-slate-900 shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5">
          <div className="p-2 border-b border-slate-100 dark:border-slate-800">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[11px] text-slate-400 dark:text-slate-500 italic">No projects match</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(`/projects/${p.id}`);
                  }}
                  dir="ltr"
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    p.id === currentId && 'bg-blue-50/60',
                  )}
                >
                  <span className={cn('flex-1 min-w-0 truncate', p.id === currentId ? 'font-semibold text-blue-700' : 'text-slate-700 dark:text-slate-200')}>
                    {p.name}
                  </span>
                  {p.number && (
                    <span className="shrink-0 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-mono text-[10px] px-1.5 py-0.5">
                      {p.number}
                    </span>
                  )}
                  {p.id === currentId && <Check className="h-3.5 w-3.5 text-blue-600 shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
