import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { FilesTab } from '../files-tab';
import { TeamTableView } from './team-table-view';
import type { ProjectTeamData } from './types';

/**
 * Project Info tab: a single-page summary + edit surface for the
 * "soft" metadata that doesn't justify its own data model yet:
 * authoring tool version, weekly meeting day and a free-text summary of
 * contracted services. Plus read-only tables for files (delegated to
 * FilesTab) and contacts (delegated to TeamTableView).
 *
 * Edits use PATCH /projects/:id on blur (no save button: the form
 * autocommits on focus loss, same UX as the Description field on the
 * Edit Employee modal).
 *
 * QA6 round 3 (26.11): PATCH /projects/:id is leader or Admin only
 * (assertProjectManage). `canEdit` comes from the page's
 * `projectManageActions(...).editInfo`, the same answer that hides the
 * header's Edit pencil. Without it the fields are read-only text.
 */
export function ProjectInfoTab({ projectId, project, canEdit }: { projectId: number; project: any; canEdit: boolean }) {
  const { data: team } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

  return (
    <div className="space-y-6">
      <ProjectInfoFields projectId={projectId} project={project} canEdit={canEdit} />

      {/* Contacts table: reuses TeamTableView for consistency with the
          Team tab's table view. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Contacts &amp; Project Team</h3>
        {team ? <TeamTableView team={team} /> : <p className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading team…</p>}
      </div>

      {/* Files: reuses the existing FilesTab. Same drop-zone, same
          permission story; just a different framing on the page. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Files</h3>
        <FilesTab projectId={projectId} />
      </div>
    </div>
  );
}

type InfoField = 'weeklyMeetingDay' | 'authoringToolVersion' | 'servicesPerContract';

const INFO_FIELDS: { key: InfoField; label: string; placeholder: string; wide?: boolean }[] = [
  { key: 'weeklyMeetingDay', label: 'Weekly Meeting Day', placeholder: 'e.g. "Tuesdays at 10:00"' },
  { key: 'authoringToolVersion', label: 'Authoring Tool Version', placeholder: 'e.g. "Revit 2024.2"' },
  {
    key: 'servicesPerContract',
    label: 'Services Per Contract',
    placeholder: 'What we deliver to this customer per the contract, free text.',
    wide: true,
  },
];

/** Shown under the read-only fields so the viewer knows why there are no inputs. */
export const PROJECT_INFO_READ_ONLY_HINT = 'Only the project leader or an administrator can edit these details.';

const labelCls = 'text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block';

/**
 * The "Project Info" card. Inputs that save on blur for the leader or an
 * Admin (`canEdit`); for everyone else the same three values as text, an
 * unset one as a muted "Not set", and no input or save path at all.
 */
export function ProjectInfoFields({ projectId, project, canEdit }: { projectId: number; project: any; canEdit: boolean }) {
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) =>
      client.patch(`/projects/${projectId}`, patch).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to save'),
  });

  // Local state mirrors the project record so users can edit without
  // round-tripping on every keystroke. Commits on blur.
  const [form, setForm] = useState({
    authoringToolVersion: project?.authoringToolVersion ?? '',
    weeklyMeetingDay: project?.weeklyMeetingDay ?? '',
    servicesPerContract: project?.servicesPerContract ?? '',
  });

  // If the project payload refreshes (e.g. after a save) refresh the
  // local form so external edits land in our UI too.
  useEffect(() => {
    setForm({
      authoringToolVersion: project?.authoringToolVersion ?? '',
      weeklyMeetingDay: project?.weeklyMeetingDay ?? '',
      servicesPerContract: project?.servicesPerContract ?? '',
    });
  }, [project?.id, project?.authoringToolVersion, project?.weeklyMeetingDay, project?.servicesPerContract]);

  const commitField = (field: InfoField) => {
    if (!canEdit) return; // the API would answer 403 NOT_PROJECT_LEADER
    const cur = (project?.[field] ?? '') as string;
    const next = form[field];
    if (cur === next) return; // no-op
    save.mutate({ [field]: next || null });
  };

  const inputCls = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';

  return (
    // Quick-facts block: free-text fields side by side on wide screens,
    // stacked on narrow. Each commits on blur.
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Project Info</h3>
      {canEdit ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {INFO_FIELDS.map((f) => (
            <div key={f.key} className={cn(f.wide && 'md:col-span-2')}>
              <label htmlFor={`project-info-${f.key}`} className={labelCls}>{f.label}</label>
              {f.wide ? (
                <textarea
                  id={`project-info-${f.key}`}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  rows={4}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  onBlur={() => commitField(f.key)}
                  className={cn(inputCls, 'resize-none')}
                />
              ) : (
                <input
                  id={`project-info-${f.key}`}
                  type="text"
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  onBlur={() => commitField(f.key)}
                  className={inputCls}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {INFO_FIELDS.map((f) => {
            const value = String(project?.[f.key] ?? '').trim();
            return (
              <div key={f.key} className={cn(f.wide && 'md:col-span-2')}>
                <dt className={labelCls}>{f.label}</dt>
                <dd dir="auto" className="text-[13px] text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
                  {value || <span className="text-slate-400 dark:text-slate-500">Not set</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <p className="text-[11px] text-slate-400 dark:text-slate-500">
        {canEdit ? 'Changes save automatically when you leave a field.' : PROJECT_INFO_READ_ONLY_HINT}
      </p>
    </div>
  );
}
