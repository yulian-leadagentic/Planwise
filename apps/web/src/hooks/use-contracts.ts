import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
      toast.success('Contract created');
    },
    onError: () => {
      toast.error('Failed to create contract');
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
      toast.success('Contract updated');
    },
    onError: () => {
      toast.error('Failed to update contract');
    },
  });
}

export function useDeleteContract() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => contractsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      toast.success('Contract deleted');
    },
    onError: () => {
      toast.error('Failed to delete contract');
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
      toast.success('Billing created');
    },
    onError: () => {
      toast.error('Failed to create billing');
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
