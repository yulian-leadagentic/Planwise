import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { contractsApi } from '@/api/contracts.api';
import type { ContractQuery, CreateContractPayload, BillingPayload } from '@/api/contracts.api';

export function useContracts(params?: ContractQuery) {
  return useQuery({
    queryKey: ['contracts', params],
    queryFn: () => contractsApi.list(params),
  });
}

export function useContract(id: number) {
  return useQuery({
    queryKey: ['contracts', id],
    queryFn: () => contractsApi.get(id),
    enabled: !!id,
  });
}

export function useCreateContract() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateContractPayload) => contractsApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      notify.success('Contract created', { code: 'CONTRACT-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create contract');
    },
  });
}

export function useUpdateContract() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<CreateContractPayload> & { id: number }) =>
      contractsApi.update(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contracts', variables.id] });
      notify.success('Contract updated', { code: 'CONTRACT-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update contract');
    },
  });
}

export function useDeleteContract() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => contractsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      notify.success('Contract deleted', { code: 'CONTRACT-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete contract');
    },
  });
}

export function useBillings(contractId: number) {
  return useQuery({
    queryKey: ['contracts', contractId, 'billings'],
    queryFn: () => contractsApi.listBillings(contractId),
    enabled: !!contractId,
  });
}

export function useCreateBilling() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ contractId, ...payload }: BillingPayload & { contractId: number }) =>
      contractsApi.createBilling(contractId, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['contracts', variables.contractId, 'billings'] });
      notify.success('Billing created', { code: 'CONTRACT-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create billing');
    },
  });
}

export function useExpenses(projectId?: number) {
  return useQuery({
    queryKey: ['expenses', projectId],
    queryFn: () => contractsApi.listExpenses({ projectId }),
  });
}

export function useMilestones(params?: { labelId?: number; partnerId?: number }) {
  return useQuery({
    queryKey: ['milestones', params],
    queryFn: () => contractsApi.listMilestones(params),
  });
}
