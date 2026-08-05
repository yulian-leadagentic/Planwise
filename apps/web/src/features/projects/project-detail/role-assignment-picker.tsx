import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass } from './constants';
import type { ProjectRoleTypeRow } from './types';

/* ─── Role Assignment Picker ────────────────────────────────────────────────
   Generic picker for any ProjectRoleType (Supplier, Architect, Engineer, …).
   Filters candidates by the role's allowedPartnerKind + requiredPartnerRoleCode.
   Creates a project_partner_role row. */

export function RoleAssignmentPicker({
  role,
  projectId,
  existingPartyIds,
  onClose,
}: {
  role: ProjectRoleTypeRow;
  projectId: number;
  existingPartyIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [titleInProject, setTitleInProject] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: candidates = [] } = useQuery<any[]>({
    queryKey: ['bp-candidates-for-role', role.id],
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: role.allowedPartnerKind === 'any' ? undefined : role.allowedPartnerKind,
        roleType: role.requiredPartnerRoleCode ?? undefined,
        perPage: 500,
      },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });
  // Filter out already-assigned parties AND, when the role requires one
  // of a set of professions (Job Titles), parties who don't hold any of
  // them. Without this second pass, the dropdown happily offered names
  // that the backend would later reject with a 400 — see the user-facing
  // "must hold one of these job titles" error.
  const requiredProfIds: number[] = Array.isArray(role.requiredProfessionIds)
    ? role.requiredProfessionIds
    : [];
  const filtered = candidates.filter((p: any) => {
    if (existingPartyIds.includes(p.id)) return false;
    if (requiredProfIds.length === 0) return true;
    const partyProfIds: number[] = Array.isArray(p.professions)
      ? p.professions.map((x: any) => x.professionId)
      : [];
    return partyProfIds.some((id) => requiredProfIds.includes(id));
  });

  const create = useMutation({
    mutationFn: () =>
      client.post('/project-partner-roles', {
        projectId,
        partyId: selectedPartyId,
        roleId: role.id,
        isPrimary,
        titleInProject: titleInProject.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success(`Added ${role.name}`, { code: 'PPR-ADD-201' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, `Failed to add ${role.name}`),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add {role.name}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300">
            Eligible: <span className="font-mono font-semibold">{role.allowedPartnerKind}</span>
            {role.requiredPartnerRoleCode && (
              <> · must hold role <span className="font-mono font-semibold">{role.requiredPartnerRoleCode}</span></>
            )}
            {requiredProfIds.length > 0 && (
              <> · must hold a required job title</>
            )}
            {role.isPrimaryRequired && <> · one PRIMARY required</>}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">{role.name}</label>
            <select
              value={selectedPartyId ?? ''}
              onChange={(e) => setSelectedPartyId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select...</option>
              {filtered.map((p: any) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
            {filtered.length === 0 && (
              <p className="text-[12px] text-amber-700 bg-amber-50 px-2 py-1.5 rounded mt-1">
                No eligible parties. Add a {role.allowedPartnerKind}
                {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''}
                {requiredProfIds.length > 0 ? ' who holds a required job title (see /partners → Job Titles)' : ''}
                {' '}in /partners first.
              </p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title / role-in-context (optional)</label>
            <input
              value={titleInProject}
              onChange={(e) => setTitleInProject(e.target.value)}
              placeholder={`e.g. "Lead ${role.name}"`}
              className={inputClass}
            />
          </div>
          {role.isPrimaryRequired && (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 pt-1">
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
              Mark as primary {role.name}
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !selectedPartyId}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : `Add ${role.name}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
