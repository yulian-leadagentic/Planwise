import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, MessageSquare, Search, Send, UserCircle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { useProjects } from '@/hooks/use-projects';
import { useFilterStore } from '@/stores/filter.store';
import { useDebounce } from '@/hooks/use-debounce';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import client from '@/api/client';

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Draft' },
  active: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Active' },
  on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
  completed: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Completed' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
};

export function ProjectListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectSearch, projectStatus, setProjectFilters } = useFilterStore();
  const debouncedSearch = useDebounce(projectSearch, 300);
  const [chatProjectId, setChatProjectId] = useState<number | null>(null);
  const [chatProjectName, setChatProjectName] = useState('');

  const { data, isLoading } = useProjects({
    search: debouncedSearch || undefined,
    status: projectStatus.length ? projectStatus[0] : undefined,
    perPage: 100,
  });

  // Fetch departments for display
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const deleteProject = useMutation({
    mutationFn: (id: number) => client.delete(`/projects/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      notify.success('Project deleted', { code: 'PROJECT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete'),
  });

  const rawProjects = data?.data ?? data;
  const projects: any[] = Array.isArray(rawProjects) ? rawProjects : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Manage your engineering projects"
        actions={
          <button onClick={() => navigate('/projects/new')}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> New Project
          </button>
        }
      />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input value={projectSearch} onChange={(e) => setProjectFilters({ projectSearch: e.target.value })}
            placeholder="Search projects..." className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
        </div>
        <select value={projectStatus[0] ?? ''} onChange={(e) => setProjectFilters({ projectStatus: e.target.value ? [e.target.value] : [] })}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="on_hold">On Hold</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {/* Project Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading projects...</div>
      ) : projects.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 bg-white py-12 text-center">
          <p className="text-sm text-slate-500">{projectSearch ? 'No projects match your search' : 'No projects yet'}</p>
          <button onClick={() => navigate('/projects/new')}
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Create Project</button>
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 text-left font-semibold">Project Code</th>
                  <th className="px-4 py-3 text-left font-semibold">Project Name</th>
                  <th className="px-4 py-3 text-left font-semibold">Team Leader</th>
                  <th className="px-4 py-3 text-left font-semibold">Department</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-left font-semibold">Category</th>
                  <th className="px-4 py-3 text-right font-semibold">Budget</th>
                  <th className="px-4 py-3 text-center font-semibold">Completion</th>
                  <th className="px-4 py-3 text-right font-semibold">Cost</th>
                  <th className="px-4 py-3 text-right font-semibold">Hours</th>
                  <th className="px-4 py-3 text-center font-semibold">Chat</th>
                  <th className="px-4 py-3 text-center font-semibold w-10"></th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p: any, idx: number) => {
                  const st = statusColors[p.status] ?? statusColors.draft;
                  const leader = p.leader;
                  const taskCount = p._count?.tasks ?? 0;
                  const completionRate = 0; // would need aggregation
                  const dept = p.department?.name ?? '-';
                  const categories = (p.categories ?? []).map((c: any) => c.serviceType?.name).filter(Boolean);
                  const category = categories.length > 0 ? categories.join(', ') : (p.projectType?.name ?? '-');

                  return (
                    <tr key={p.id}
                      onClick={() => navigate(`/projects/${p.id}`)}
                      className={cn('border-b border-slate-100 cursor-pointer hover:bg-blue-50/30 transition-colors',
                        idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30')}>
                      <td className="px-4 py-3 font-mono text-slate-500">{p.number || '-'}</td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-800">{p.name}</p>
                      </td>
                      <td className="px-4 py-3">
                        {leader ? (
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center">
                              {(leader.firstName?.[0] ?? '') + (leader.lastName?.[0] ?? '')}
                            </div>
                            <span className="text-slate-700">{leader.firstName} {leader.lastName}</span>
                          </div>
                        ) : <span className="text-slate-300">-</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{dept}</td>
                      <td className="px-4 py-3">
                        <span className={cn('rounded-[5px] px-2 py-0.5 text-[10px] font-bold', st.bg, st.text)}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{category}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {p.budget ? `₪${Number(p.budget).toLocaleString()}` : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full" style={{ width: '0%' }} />
                          </div>
                          <span className="text-[11px] text-slate-500">0%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500">-</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500">-</td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={() => { setChatProjectId(p.id); setChatProjectName(p.name); }}
                            title="Project discussion"
                            className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                          {leader && (
                            <button onClick={() => { setChatProjectId(p.id); setChatProjectName(`Message to ${leader.firstName}`); }}
                              title={`Quick message to ${leader.firstName} ${leader.lastName}`}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { if (confirm(`Delete "${p.name}"?`)) deleteProject.mutate(p.id); }}
                          className="w-7 h-7 rounded-md flex items-center justify-center text-slate-300 hover:text-red-600 hover:bg-red-50 transition-colors">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Discussion Drawer for chat */}
      {chatProjectId && (
        <DiscussionDrawer
          open={!!chatProjectId}
          onClose={() => setChatProjectId(null)}
          entityType="project"
          entityId={chatProjectId}
          title={chatProjectName}
        />
      )}
    </div>
  );
}
