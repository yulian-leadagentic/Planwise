import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { Modal } from '@/components/shared/modal';
import { inputClass } from './constants';

/* ─── Customer Contact Picker ───────────────────────────────────────────────
   Attaches a person to THIS project as a customer contact.

   People UX M1 (E-05) — the shell (dialog role, aria-modal, Tab trap,
   Escape, focus return, dirty guard) now comes from the shared Modal.
   The picker owns just the form + mutation. */

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

  const { data: persons = [], isLoading: personsLoading } = useQuery<any[]>({
    queryKey: ['bp-persons-for-customer-contact', customerOrgId],
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: 'person',
        employerId: customerOrgId,
        excludeInternal: true,
        perPage: 500,
      },
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
      queryClient.invalidateQueries({ queryKey: ['assignee-candidates', projectId] });
      notify.success('Contact added', { code: 'CUSTOMER-CONTACT-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add contact'),
  });

  const isDirty = selectedPersonId != null || titleAtCustomer.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add Contact at ${customerName}`}
      widthClass="w-[440px] max-w-[92vw]"
      isDirty={isDirty}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || !selectedPersonId}
            className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {create.isPending ? 'Adding...' : 'Add Contact'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Person</label>
          <select
            value={selectedPersonId ?? ''}
            onChange={(e) => setSelectedPersonId(Number(e.target.value) || null)}
            className={inputClass}
          >
            <option value="">
              {personsLoading ? 'Loading…' : 'Select a person...'}
            </option>
            {filtered.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.displayName}{p.email ? ` — ${p.email}` : ''}
              </option>
            ))}
          </select>
          {!personsLoading && filtered.length === 0 && (
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
              No contacts at {customerName} yet. Add one from the customer's card
              (Contacts → By Customer → this org → Add contact) first.
            </p>
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
      </div>
    </Modal>
  );
}
