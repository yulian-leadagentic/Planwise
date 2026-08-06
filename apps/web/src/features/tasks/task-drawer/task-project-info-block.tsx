import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { NavLinkWithReturn } from '@/components/nav/return-route';

export function TaskProjectInfoBlock({ projectId, backLabel }: { projectId: number; backLabel: string }) {
  const { data: project, isLoading } = useQuery({
    queryKey: ['project-info-summary', projectId],
    queryFn: () => client.get(`/projects/${projectId}`).then((r) => r.data?.data ?? r.data),
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) {
    return <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3 text-[12px] text-slate-400 dark:text-slate-500">Loading project info…</div>;
  }
  if (!project) return null;

  // Always-rendered list (Z1 follow-up) — the user wants the task card's
  // Project Info to mirror the Project Info tab, so we show every field
  // with an em-dash placeholder rather than hiding empties. Helpers
  // resolve URL fields into click-throughs.
  const fmtVal = (v?: string | null) => (v && v.trim() ? v : null);
  const fields: Array<{ label: string; value: string | null; isLink?: boolean }> = [
    { label: 'Weekly Meeting', value: fmtVal(project.weeklyMeetingDay) },
    { label: 'Authoring Tool', value: fmtVal(project.authoringToolVersion) },
  ];

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Project Info</span>
        <NavLinkWithReturn
          to={`/projects/${projectId}`}
          returnLabel={backLabel}
          className="text-[10px] text-blue-600 hover:underline"
        >
          Open project →
        </NavLinkWithReturn>
      </div>
      <dl className="space-y-1 text-[12px]">
        <div className="flex gap-2">
          <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">Project:</dt>
          <dd className="text-slate-700 dark:text-slate-200 font-medium break-words min-w-0">{project.name}</dd>
        </div>
        {/* BIM Leader — resolved from the project_partner_roles row with
            role.code = bim_leader (see projects.service.findOne). Shown
            here per user feedback 2026-06-22 — task owners need to know
            who owns BIM for the project without digging into the team
            tab. Falls back to em-dash when unassigned. */}
        <div className="flex gap-2">
          <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">BIM Leader:</dt>
          <dd className="text-slate-700 dark:text-slate-200 break-words min-w-0">
            {project.bimLeader ? (
              `${project.bimLeader.firstName ?? ''} ${project.bimLeader.lastName ?? ''}`.trim() || (
                <span className="text-slate-300 dark:text-slate-600 italic">—</span>
              )
            ) : (
              <span className="text-slate-300 dark:text-slate-600 italic">—</span>
            )}
          </dd>
        </div>
        {fields.map((f) => (
          <div key={f.label} className="flex gap-2">
            <dt className="text-slate-500 dark:text-slate-400 w-[110px] shrink-0">{f.label}:</dt>
            <dd className="text-slate-700 dark:text-slate-200 break-words min-w-0">
              {f.value == null ? (
                <span className="text-slate-300 dark:text-slate-600 italic">—</span>
              ) : f.isLink ? (
                // The hub field can hold multiple "Label | URL" lines.
                // Render each on its own row; linkify URLs.
                f.value.split('\n').map((line, i) => {
                  const trimmed = line.trim();
                  if (!trimmed) return null;
                  const sep = trimmed.indexOf('|');
                  const label = sep >= 0 ? trimmed.slice(0, sep).trim() : '';
                  const url = sep >= 0 ? trimmed.slice(sep + 1).trim() : trimmed;
                  return (
                    <div key={i}>
                      {label && <span className="text-slate-500 dark:text-slate-400">{label}: </span>}
                      {/^https?:\/\//.test(url)
                        ? <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">{url}</a>
                        : <span className="break-all">{url}</span>}
                    </div>
                  );
                })
              ) : f.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
        <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider">Services Per Contract</span>
        <p className="text-[12px] text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">
          {project.servicesPerContract?.trim() || <span className="text-slate-300 dark:text-slate-600 italic">—</span>}
        </p>
      </div>
    </div>
  );
}
