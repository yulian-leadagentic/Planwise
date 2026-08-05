import { X, Plus } from 'lucide-react';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { CreateContactModal } from '@/features/partners/create-contact-modal';
import type { PickerMode } from './types';

/* ─── Project BP Picker ────────────────────────────────────────────────────
   Legacy picker — still used by the Add Team Member dialog elsewhere. Kept
   for now; will be removed when M7 drops legacy surfaces.
     - 'customer-contact'  → adds a worker_of-the-customer to the project
                              (creates participates_in_project)
     - 'supplier'          → adds a supplier organization to the project
                              (creates supplier_of_project)
     - 'supplier-worker'   → adds a worker_of-this-supplier to the project
                              (creates participates_in_project)
   Validation rules in the backend prevent mismatches; the picker pre-filters
   client-side so users only see candidates that the rules would accept.
*/

export function ProjectBpPicker({
  mode,
  projectId,
  customerOrgId,
  supplierOrgId,
  existingBpIds,
  onClose,
}: {
  mode: PickerMode;
  projectId: number;
  customerOrgId: number | null;
  supplierOrgId: number | null;
  existingBpIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedBpId, setSelectedBpId] = useState<number | null>(null);
  const [roleInContext, setRoleInContext] = useState('');
  // When set, we surface the CreateContactModal pinned to a specific
  // employer org so users can add a brand-new contact without leaving
  // this picker. Currently only used for the customer-contact mode and
  // supplier-worker mode.
  const [createForOrgId, setCreateForOrgId] = useState<number | null>(null);

  const config = {
    'customer-contact': {
      title: 'Add Customer Contact',
      blurb: 'Pick a person who works at the customer organization. Only people whose Worker_of points to the customer of this project are listed.',
      partnerType: 'person' as const,
      relationshipCode: 'participates_in_project',
      filterEmployerOrgId: customerOrgId,
      showRoleInContext: true,
    },
    'supplier': {
      title: 'Add Supplier to Project',
      blurb: 'Pick an organization with the "supplier" role to add as a supplier on this project.',
      partnerType: 'organization' as const,
      relationshipCode: 'supplier_of_project',
      filterRoleCode: 'supplier',
      showRoleInContext: false,
    },
    'supplier-worker': {
      title: 'Add Supplier Worker',
      blurb: 'Pick a person who works at this supplier. Only Workers_of this supplier are listed.',
      partnerType: 'person' as const,
      relationshipCode: 'participates_in_project',
      filterEmployerOrgId: supplierOrgId,
      showRoleInContext: true,
    },
  }[mode];

  // Search the BP space with the right type filter.
  const { data: bps = [] } = useQuery<any[]>({
    queryKey: ['bp-picker', mode, search, customerOrgId, supplierOrgId],
    queryFn: () => client.get('/business-partners', {
      params: {
        partnerType: config.partnerType,
        roleType: (config as any).filterRoleCode,
        search: search || undefined,
        perPage: 100,
      },
    }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });

  // Fetch worker_of relationships for the candidates so we can filter
  // persons to those actually employed by the right org.
  const filterEmployerOrgId = (config as any).filterEmployerOrgId as number | null | undefined;
  const filtered = bps.filter((bp: any) => {
    if (existingBpIds.includes(bp.id)) return false;
    if (config.partnerType === 'person' && filterEmployerOrgId) {
      const employers = (bp.outgoingRelationships ?? [])
        .filter((r: any) =>
          r.relationshipType?.code === 'worker_of' &&
          r.targetType === 'organization' &&
          (!r.validTo || new Date(r.validTo) > new Date()),
        )
        .map((r: any) => r.targetId);
      return employers.includes(filterEmployerOrgId);
    }
    return true;
  });

  // Resolve the relationship type id by code at submit time.
  const { data: allRelTypes = [] } = useQuery<any[]>({
    queryKey: ['partner-relationship-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/partner-types/relationship-types').then((r) => r.data?.data ?? r.data ?? []),
  });
  const relType = allRelTypes.find((rt: any) => rt.code === config.relationshipCode);

  const create = useMutation({
    mutationFn: () =>
      client.post('/business-partner-relationships', {
        sourcePartnerId: selectedBpId,
        targetType: 'project',
        targetId: projectId,
        relationshipTypeId: relType?.id,
        roleInContext: roleInContext.trim() || undefined,
      }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-team', projectId] });
      notify.success('Added to project', { code: 'PROJECT-TEAM-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add'),
  });

  const handleSubmit = () => {
    if (!selectedBpId || !relType) {
      notify.warning('Pick a candidate first', { code: 'PROJECT-TEAM-400' });
      return;
    }
    create.mutate();
  };

  const blockedReason =
    mode === 'customer-contact' && !customerOrgId
      ? 'No customer is set on this project — set the customer first.'
      : mode === 'supplier-worker' && !supplierOrgId
      ? 'Pick a supplier from the project first, then add its workers.'
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{config.title}</h2>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500 dark:text-slate-400">{config.blurb}</p>

          {blockedReason ? (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700">
              {blockedReason}
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase">Search</label>
                  {/* Inline-create path. Only shown when the picker is scoped
                      to a specific employer org (customer-contact /
                      supplier-worker). Skips the trip to Partners → Contacts
                      and pre-pins the customer/supplier as the employer. */}
                  {filterEmployerOrgId && (
                    <button
                      type="button"
                      onClick={() => setCreateForOrgId(filterEmployerOrgId)}
                      className="flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 hover:border-blue-400 hover:text-blue-600 text-slate-600 dark:text-slate-300 text-[11px] font-semibold px-2 py-0.5"
                    >
                      <Plus className="h-3 w-3" /> New contact
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={config.partnerType === 'organization' ? 'Company name, email...' : 'Name, email...'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-slate-400 dark:text-slate-500 text-center italic">
                      {search ? 'No matches.' : (
                        config.partnerType === 'organization'
                          ? 'No suppliers available. Add one in Partners → Organizations.'
                          : (filterEmployerOrgId
                              ? 'No people work for this organization yet — click "New contact" above to add one.'
                              : 'Type to search.')
                      )}
                    </div>
                  ) : filtered.slice(0, 50).map((bp: any) => (
                    <button
                      key={bp.id}
                      type="button"
                      onClick={() => setSelectedBpId(bp.id)}
                      className={cn(
                        'w-full text-left px-3 py-2 text-sm border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-blue-50',
                        selectedBpId === bp.id && 'bg-blue-50',
                      )}
                    >
                      <p className="font-medium text-slate-800 dark:text-slate-100">{bp.displayName}</p>
                      {bp.email && <p className="text-[11px] text-slate-400 dark:text-slate-500">{bp.email}</p>}
                    </button>
                  ))}
                </div>
              </div>

              {config.showRoleInContext && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase mb-1 block">Role on this project (optional)</label>
                  <input
                    type="text"
                    value={roleInContext}
                    onChange={(e) => setRoleInContext(e.target.value)}
                    placeholder='e.g. "Client Operations Manager", "BIM Manager", "Site Lead"'
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={onClose} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg">Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={create.isPending || !selectedBpId || !!blockedReason}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {create.isPending ? 'Adding...' : 'Add to Project'}
            </button>
          </div>
        </div>
      </div>

      {/* In-line "create new contact pinned to this customer/supplier" modal.
          When the user finishes creating, we invalidate the BP query and
          auto-select the new BP so they can hit "Add to Project" in one go. */}
      {createForOrgId != null && (
        <CreateContactModal
          preselectEmployerOrgId={createForOrgId}
          lockEmployer    /* this flow is 'create a contact FOR this customer/supplier' */
          onClose={() => setCreateForOrgId(null)}
          onCreated={(newBpId) => {
            setCreateForOrgId(null);
            setSelectedBpId(newBpId);
            queryClient.invalidateQueries({ queryKey: ['bp-picker'] });
          }}
        />
      )}
    </div>
  );
}
