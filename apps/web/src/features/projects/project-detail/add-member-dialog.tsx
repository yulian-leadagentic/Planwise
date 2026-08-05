import { X, Users } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';
import { useAddProjectMember } from '@/hooks/use-projects';
import { getInitials } from './utils';
import type { User } from './types';

/* ─── Add Member Dialog ─────────────────────────────────────────────────────── */

export function AddMemberDialog({
  projectId,
  existingMemberIds,
  onClose,
}: {
  projectId: number;
  existingMemberIds: number[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'individual' | 'template'>('individual');
  const [search, setSearch] = useState('');
  const [applying, setApplying] = useState(false);
  const queryClient = useQueryClient();

  const { data: users = [], isLoading: loadingUsers } = useQuery<User[]>({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      // perPage=1000 — load every active user so the client-side search
      // can hit anyone in the company. Default page size is 20, which
      // silently dropped employees past row 20 (Alex Isakov was missing
      // from the Add Team Member picker on staging, 2026-06-21).
      client.get('/users?isActive=true&perPage=1000').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const { data: teamTemplates = [], isLoading: loadingTemplates } = useQuery<any[]>({
    queryKey: ['team-templates'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/team-templates').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const addMember = useAddProjectMember();

  const filteredUsers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return users.filter((u) => {
      if (existingMemberIds.includes(u.id)) return false;
      if (!q) return true;
      const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return full.includes(q);
    });
  }, [users, search, existingMemberIds]);

  const handleAdd = (user: User) => {
    addMember.mutate(
      { projectId, userId: user.id },
      {
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  const handleApplyTemplate = async (template: any) => {
    const templateMemberIds: number[] = (template.members || [])
      .map((m: any) => m.userId ?? m.user?.id)
      .filter((id: any): id is number => typeof id === 'number')
      .filter((id: number) => !existingMemberIds.includes(id));

    if (templateMemberIds.length === 0) {
      notify.info('All members from this template are already on the project');
      return;
    }

    // Bypass the useAddProjectMember hook so we don't fire one toast per member.
    // Add all members in parallel via direct API calls, then show a single notification.
    setApplying(true);
    const results = await Promise.allSettled(
      templateMemberIds.map((userId) =>
        client.post(`/projects/${projectId}/members`, { userId }),
      ),
    );
    const added = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - added;

    // Refresh the members list
    queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'members'] });
    setApplying(false);

    if (added > 0 && failed === 0) {
      notify.success(
        `Added ${added} member${added !== 1 ? 's' : ''} from "${template.name}"`,
        { code: 'TEAM-APPLY-200' },
      );
    } else if (added > 0 && failed > 0) {
      notify.warning(
        `Added ${added}, ${failed} failed from "${template.name}"`,
        { code: 'TEAM-APPLY-207' },
      );
    } else {
      notify.error(`Could not add members from "${template.name}"`, {
        code: 'TEAM-APPLY-500',
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-2xl">
        {/* Dialog header */}
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add Team Member</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
           aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 px-5">
          <button
            onClick={() => setTab('individual')}
            className={cn(
              'border-b-2 px-1 py-2 text-xs font-semibold transition-colors mr-4',
              tab === 'individual'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
            )}
          >
            Individual
          </button>
          <button
            onClick={() => setTab('template')}
            className={cn(
              'border-b-2 px-1 py-2 text-xs font-semibold transition-colors flex items-center gap-1',
              tab === 'template'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200',
            )}
          >
            <Users className="h-3 w-3" />
            From Team Template
          </button>
        </div>

        {tab === 'individual' ? (
          <>
            {/* Search */}
            <div className="px-5 pt-4">
              <input
                type="text"
                placeholder="Search employees..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                autoFocus
              />
            </div>

            {/* User list */}
            <div className="max-h-64 overflow-y-auto px-5 py-3">
              {loadingUsers ? (
                <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">Loading...</p>
              ) : filteredUsers.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
                  {search ? 'No matching employees' : 'No available employees'}
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredUsers.map((user) => {
                    const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Unknown';
                    const email = typeof user.email === 'string' ? user.email : '';
                    return (
                      <div
                        key={user.id}
                        className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-semibold text-indigo-600">
                          {getInitials(user.firstName ?? '', user.lastName ?? '')}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{fullName}</p>
                          {email && <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{email}</p>}
                        </div>
                        <button
                          onClick={() => handleAdd(user)}
                          disabled={addMember.isPending}
                          className="rounded-md bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
                        >
                          Add
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="max-h-80 overflow-y-auto px-5 py-4">
            {loadingTemplates ? (
              <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">Loading templates...</p>
            ) : teamTemplates.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">
                No team templates available. Create one in Templates → Team Templates.
              </p>
            ) : (
              <div className="space-y-2">
                {teamTemplates.map((t) => {
                  const members = Array.isArray(t.members) ? t.members : [];
                  const availableCount = members
                    .map((m: any) => m.userId ?? m.user?.id)
                    .filter((id: any) => typeof id === 'number' && !existingMemberIds.includes(id))
                    .length;
                  const totalCount = members.length;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleApplyTemplate(t)}
                      disabled={applying || availableCount === 0}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-left hover:border-blue-400 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            {availableCount} of {totalCount} member{totalCount !== 1 ? 's' : ''} available
                          </p>
                          {members.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {members.slice(0, 6).map((m: any) => {
                                const u = m.user ?? {};
                                const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown';
                                return (
                                  <span
                                    key={m.id}
                                    className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-600 dark:text-slate-300"
                                  >
                                    {name}
                                  </span>
                                );
                              })}
                              {members.length > 6 && (
                                <span className="text-[11px] text-slate-400 dark:text-slate-500">+{members.length - 6} more</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Dialog footer spacer */}
        <div className="h-3" />
      </div>
    </div>
  );
}
