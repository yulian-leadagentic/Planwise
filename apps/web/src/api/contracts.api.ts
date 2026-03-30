import client from './client';
import type {
  ApiResponse,
  Contract,
  ContractItem,
  Billing,
  LabelMilestone,
  Contact,
  Expense,
  Term,
  PaginationQuery,
} from '@/types';

export interface ContractQuery extends PaginationQuery {
  status?: string;
  projectId?: number;
  partnerId?: number;
  search?: string;
}

export interface CreateContractPayload {
  name: string;
  projectId?: number;
  partnerId: number;
  status?: string;
  totalAmount?: number;
  startDate?: string;
  endDate?: string;
  notes?: string;
}

export interface ContractItemPayload {
  labelId?: number;
  milestoneId?: number;
  description: string;
  quantity: number;
  unitPrice: number;
  sortOrder?: number;
}

export interface BillingPayload {
  contractId: number;
  type: string;
  amount: number;
  billingDate: string;
  description?: string;
  status?: string;
}

export interface MilestonePayload {
  labelId: number;
  partnerId: number;
  name: string;
  dueDate?: string;
  amount?: number;
  notes?: string;
}

export interface ContactPayload {
  partnerId: number;
  name: string;
  email?: string;
  phone?: string;
  role?: string;
}

export interface ExpensePayload {
  projectId: number;
  expenseType: string;
  amount: number;
  date: string;
  description?: string;
  receiptUrl?: string;
}

export interface TermPayload {
  userId: number;
  title: string;
  monthlySalary?: number;
  hourlyRate?: number;
  startDate: string;
  endDate?: string;
}

export const contractsApi = {
  // Contracts — backend: ContractsController at /contracts
  list: (params?: ContractQuery) =>
    client.get<ApiResponse<Contract[]>>('/contracts', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<ApiResponse<Contract>>(`/contracts/${id}`).then((r) => r.data.data),

  create: (payload: CreateContractPayload) =>
    client.post<ApiResponse<Contract>>('/contracts', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateContractPayload>) =>
    client.patch<ApiResponse<Contract>>(`/contracts/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/contracts/${id}`).then((r) => r.data),

  // Contract items — backend: POST/PATCH/DELETE /contracts/:id/items
  listItems: (contractId: number) =>
    client.get<ApiResponse<ContractItem[]>>(`/contracts/${contractId}/items`).then((r) => r.data.data),

  addItem: (contractId: number, payload: ContractItemPayload) =>
    client.post<ApiResponse<ContractItem>>(`/contracts/${contractId}/items`, payload).then((r) => r.data.data),

  updateItem: (contractId: number, itemId: number, payload: Partial<ContractItemPayload>) =>
    client.patch<ApiResponse<ContractItem>>(`/contracts/${contractId}/items/${itemId}`, payload).then((r) => r.data.data),

  deleteItem: (contractId: number, itemId: number) =>
    client.delete(`/contracts/${contractId}/items/${itemId}`).then((r) => r.data),

  // Billings — backend: BillingsController at /billings
  listBillings: (params?: { contractId?: number }) =>
    client.get<ApiResponse<Billing[]>>('/billings', { params }).then((r) => r.data.data),

  createBilling: (payload: BillingPayload) =>
    client.post<ApiResponse<Billing>>('/billings', payload).then((r) => r.data.data),

  getBilling: (id: number) =>
    client.get<ApiResponse<Billing>>(`/billings/${id}`).then((r) => r.data.data),

  updateBilling: (id: number, payload: Partial<BillingPayload>) =>
    client.patch<ApiResponse<Billing>>(`/billings/${id}`, payload).then((r) => r.data.data),

  // Milestones — backend: /contracts/:contractId/milestones
  createMilestone: (contractId: number, payload: MilestonePayload) =>
    client.post<ApiResponse<LabelMilestone>>(`/contracts/${contractId}/milestones`, payload).then((r) => r.data.data),

  updateMilestone: (id: number, payload: Partial<MilestonePayload & { isCompleted: boolean }>) =>
    client.patch<ApiResponse<LabelMilestone>>(`/contracts/milestones/${id}`, payload).then((r) => r.data.data),

  deleteMilestone: (id: number) =>
    client.delete(`/contracts/milestones/${id}`).then((r) => r.data),

  // Contacts — backend: /contracts/contacts
  listContacts: (partnerId: number) =>
    client.get<ApiResponse<Contact[]>>(`/contracts/contacts/${partnerId}`).then((r) => r.data.data),

  createContact: (payload: ContactPayload) =>
    client.post<ApiResponse<Contact>>('/contracts/contacts', payload).then((r) => r.data.data),

  deleteContact: (id: number) =>
    client.delete(`/contracts/contacts/${id}`).then((r) => r.data),

  // Expenses — backend: /contracts/expenses
  listExpenses: (params?: { projectId?: number }) =>
    client.get<ApiResponse<Expense[]>>('/contracts/expenses', { params }).then((r) => r.data.data),

  createExpense: (payload: ExpensePayload) =>
    client.post<ApiResponse<Expense>>('/contracts/expenses', payload).then((r) => r.data.data),

  // Terms — backend: /contracts/terms
  listTerms: (userId: number) =>
    client.get<ApiResponse<Term[]>>(`/contracts/terms/${userId}`).then((r) => r.data.data),

  createTerm: (payload: TermPayload) =>
    client.post<ApiResponse<Term>>('/contracts/terms', payload).then((r) => r.data.data),
};
