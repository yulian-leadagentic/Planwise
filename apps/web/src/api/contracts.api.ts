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
  // Contracts
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

  // Contract items
  listItems: (contractId: number) =>
    client.get<ApiResponse<ContractItem[]>>(`/contracts/${contractId}/items`).then((r) => r.data.data),

  setItems: (contractId: number, items: ContractItemPayload[]) =>
    client.put<ApiResponse<ContractItem[]>>(`/contracts/${contractId}/items`, { items }).then((r) => r.data.data),

  // Billings
  listBillings: (contractId: number) =>
    client.get<ApiResponse<Billing[]>>(`/contracts/${contractId}/billings`).then((r) => r.data.data),

  createBilling: (contractId: number, payload: BillingPayload) =>
    client.post<ApiResponse<Billing>>(`/contracts/${contractId}/billings`, payload).then((r) => r.data.data),

  updateBilling: (contractId: number, billingId: number, payload: Partial<BillingPayload>) =>
    client.patch<ApiResponse<Billing>>(`/contracts/${contractId}/billings/${billingId}`, payload).then((r) => r.data.data),

  deleteBilling: (contractId: number, billingId: number) =>
    client.delete(`/contracts/${contractId}/billings/${billingId}`).then((r) => r.data),

  // Milestones
  listMilestones: (params?: { labelId?: number; partnerId?: number }) =>
    client.get<ApiResponse<LabelMilestone[]>>('/milestones', { params }).then((r) => r.data.data),

  createMilestone: (payload: MilestonePayload) =>
    client.post<ApiResponse<LabelMilestone>>('/milestones', payload).then((r) => r.data.data),

  updateMilestone: (id: number, payload: Partial<MilestonePayload & { isCompleted: boolean }>) =>
    client.patch<ApiResponse<LabelMilestone>>(`/milestones/${id}`, payload).then((r) => r.data.data),

  deleteMilestone: (id: number) =>
    client.delete(`/milestones/${id}`).then((r) => r.data),

  // Contacts
  listContacts: (partnerId: number) =>
    client.get<ApiResponse<Contact[]>>(`/users/${partnerId}/contacts`).then((r) => r.data.data),

  createContact: (payload: ContactPayload) =>
    client.post<ApiResponse<Contact>>('/contacts', payload).then((r) => r.data.data),

  updateContact: (id: number, payload: Partial<ContactPayload>) =>
    client.patch<ApiResponse<Contact>>(`/contacts/${id}`, payload).then((r) => r.data.data),

  deleteContact: (id: number) =>
    client.delete(`/contacts/${id}`).then((r) => r.data),

  // Expenses
  listExpenses: (params?: { projectId?: number }) =>
    client.get<ApiResponse<Expense[]>>('/expenses', { params }).then((r) => r.data.data),

  createExpense: (payload: ExpensePayload) =>
    client.post<ApiResponse<Expense>>('/expenses', payload).then((r) => r.data.data),

  updateExpense: (id: number, payload: Partial<ExpensePayload>) =>
    client.patch<ApiResponse<Expense>>(`/expenses/${id}`, payload).then((r) => r.data.data),

  deleteExpense: (id: number) =>
    client.delete(`/expenses/${id}`).then((r) => r.data),

  // Terms
  listTerms: (userId: number) =>
    client.get<ApiResponse<Term[]>>(`/users/${userId}/terms`).then((r) => r.data.data),

  createTerm: (payload: TermPayload) =>
    client.post<ApiResponse<Term>>('/terms', payload).then((r) => r.data.data),

  updateTerm: (id: number, payload: Partial<TermPayload>) =>
    client.patch<ApiResponse<Term>>(`/terms/${id}`, payload).then((r) => r.data.data),

  deleteTerm: (id: number) =>
    client.delete(`/terms/${id}`).then((r) => r.data),
};
