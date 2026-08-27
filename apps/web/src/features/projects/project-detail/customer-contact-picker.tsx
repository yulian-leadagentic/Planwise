import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass } from './constants';

/* ─── Customer Contact Picker ───────────────────────────────────────────────
   Attaches a person to THIS project as a customer contact.

   PR-026 (2026-08-27, docs/bm2/bm2-qa2-cc-specs.md Commit 3) — write path
   changed from the org-wide `partner_relationships` edge to a
   project-scoped `project_partner_role` row so the contact only appears
   on the project it was attached to (not on every project of the same
   customer). The row shape:
     projectId       = this project
     partyId         = the customer organisation
     roleId          = the 'customer_contact' project role type
     contactPartyId  = the selected person
   Mirrors the existing "org party + contact person" convention read by
   getAssigneeCandidates and enforced by ProjectPartnerRolesService.create
   (which requires party.partnerType === 'organization' when
   contactPartyId is set).

   Candidate source is KEPT as-is (all persons) — the picker still lets you
   pick any person BP, and the person can be attached to this project
   even if they have no worker_of edge to the customer org (multi-employer
   / freelancer cases stay working). The org-level worker_of /
   contact_of_customer edges remain untouched as the wider candidate
   seed for future filtering. */

export function CustomerContactPicker({
  projectId,
  customerOrgId,
  customerName,
  customerContactRoleId,
  existingContactBpIds,
  onClose,
}: {
  projectId: number;
  customerOrgId: number;
  customerName: string;
  customerContactRoleId: number;
  existingContactBpIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [titleAtCustomer, setTitleAtCustomer] = useState('');

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const { data: persons = [] } = useQuery<any[]>({
    queryKey: ['bp-persons-for-customer-contact', customerOrgId],
    queryFn: () => client.get('/business-partners', {
      params: { partnerType: 'person', perPage: 500 },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });
  const filtered = persons.filter((p: any) => !existingContactBpIds.includes(p.id));

  const create = useMutation({
    mutationFn: () => {
      if (!selectedPersonId) {
        throw new Error('Missing person');
      }
      // PR-026: write a project-scoped project_partner_role row.
      // party = customer org, role = 'customer_contact',
      // contactParty = the person. The backend enforces the shape
      // (organization party + person contact) and rejects mismatches.
      return client.post('/project-partner-roles', {
        projectId,
        partyId: customerOrgId,
        roleId: customerContactRoleId,
        contactPartyId: selectedPersonId,
        titleInProject: titleAtCustomer.trim() || undefined,
      }).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team'] });
      queryClient.invalidateQueries({ queryKey: ['business-partners'] });
      // Branch 2 · fix/assignee-source — keep the task-tree picker
      // in sync when a customer contact is added.
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      notify.success('Contact added', { code: 'CUSTOMER-CONTACT-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add contact'),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Add Contact at {customerName}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Person</label>
            <select
              value={selectedPersonId ?? ''}
              onChange={(e) => setSelectedPersonId(Number(e.target.value) || null)}
              className={inputClass}
            >
              <option value="">Select a person...</option>
              {filtered.map((p: any) => (
                <option key={p.id} value={p.id}>{p.displayName}{p.email ? ` — ${p.email}` : ''}</option>
              ))}
            </select>
            {filtered.length === 0 && (
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">No people available. All are already contacts, or no persons exist yet.</p>
            )}
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Title at customer (optional)</label>
            <input
              value={titleAtCustomer}
              onChange={(e) => setTitleAtCustomer(e.target.value)}
              placeholder='e.g. "CFO", "Operations Manager"'
              className={inputClass}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !selectedPersonId}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : 'Add Contact'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
