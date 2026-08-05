import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { FilesTab } from '../files-tab';
import { TeamTableView } from './team-table-view';
import type { ProjectTeamData } from './types';

/**
 * Project Info tab — a single-page summary + edit surface for the
 * "soft" metadata that doesn't justify its own data model yet:
 * authoring tool version, weekly meeting day, file system / hub link,
 * and a free-text summary of contracted services. Plus read-only tables
 * for files (delegated to FilesTab) and contacts (delegated to
 * TeamTableView).
 *
 * Edits use PATCH /projects/:id on blur (no save button — the form
 * autocommits on focus loss, same UX as the Description field on the
 * Edit Employee modal).
 */
export function ProjectInfoTab({ projectId, project }: { projectId: number; project: any }) {
  const queryClient = useQueryClient();
  const { data: team } = useQuery<ProjectTeamData>({
    queryKey: ['project-team', projectId],
    queryFn: () => client.get(`/projects/${projectId}/team`).then((r) => r.data?.data ?? r.data),
  });

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

  const commitField = (field: keyof typeof form) => {
    const cur = (project?.[field] ?? '') as string;
    const next = form[field];
    if (cur === next) return; // no-op
    save.mutate({ [field]: next || null });
  };

  const inputCls = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';

  return (
    <div className="space-y-6">
      {/* Quick-facts block — 4 free-text fields side by side on wide
          screens, stacked on narrow. Each commits on blur. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Project Info</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Weekly Meeting Day</label>
            <input
              type="text"
              value={form.weeklyMeetingDay}
              placeholder='e.g. "Tuesdays at 10:00"'
              onChange={(e) => setForm((f) => ({ ...f, weeklyMeetingDay: e.target.value }))}
              onBlur={() => commitField('weeklyMeetingDay')}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Authoring Tool Version</label>
            <input
              type="text"
              value={form.authoringToolVersion}
              placeholder='e.g. "Revit 2024.2"'
              onChange={(e) => setForm((f) => ({ ...f, authoringToolVersion: e.target.value }))}
              onBlur={() => commitField('authoringToolVersion')}
              className={inputCls}
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5 block">Services Per Contract</label>
            <textarea
              value={form.servicesPerContract}
              placeholder="What we deliver to this customer per the contract — free text."
              rows={4}
              onChange={(e) => setForm((f) => ({ ...f, servicesPerContract: e.target.value }))}
              onBlur={() => commitField('servicesPerContract')}
              className={cn(inputCls, 'resize-none')}
            />
          </div>
        </div>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">Changes save automatically when you leave a field.</p>
      </div>

      {/* Contacts table — reuses TeamTableView for consistency with the
          Team tab's table view. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Contacts &amp; Project Team</h3>
        {team ? <TeamTableView team={team} /> : <p className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading team…</p>}
      </div>

      {/* Files — reuses the existing FilesTab. Same drop-zone, same
          permission story; just a different framing on the page. */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Files</h3>
        <FilesTab projectId={projectId} />
      </div>
    </div>
  );
}
