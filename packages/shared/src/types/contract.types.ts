import { ContractStatus, BillingStatus, BillingType, ExpenseType } from './enums';

export interface Contract {
  id: number;
  name: string;
  projectId: number | null;
  /** LEGACY — User FK. Kept for one release; prefer `partyId`. */
  partnerId: number;
  /**
   * Phase 4 · Stage 3 (2026-09-28) — the BusinessPartner this contract is
   * with (organization or person). Populated by the party read include on
   * the API side; nullable until every row has been backfilled by the
   * follow-up migration that retires `partnerId`.
   */
  partyId?: number | null;
  status: ContractStatus;
  totalAmount: number | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  /** LEGACY — User relation. Prefer `party` for the display name. */
  partner?: {
    id: number;
    firstName: string;
    lastName: string;
    companyName: string | null;
  };
  /**
   * Phase 4 · Stage 3 (2026-09-28) — BusinessPartner relation. When
   * present, this is the canonical party of the contract; reader UIs
   * should prefer `party.displayName` and fall back to the legacy
   * `partner` name only when `party` is null.
   */
  party?: {
    id: number;
    partnerType: 'organization' | 'person';
    displayName: string;
    companyName?: string | null;
    email?: string | null;
  } | null;
  project?: {
    id: number;
    name: string;
  };
  items?: ContractItem[];
}

export interface ContractItem {
  id: number;
  contractId: number;
  labelId: number | null;
  milestoneId: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  sortOrder: number;
}

export interface Billing {
  id: number;
  contractId: number;
  type: BillingType;
  amount: number;
  billingDate: string;
  description: string | null;
  status: BillingStatus;
  pdfUrl: string | null;
  createdBy: number;
  createdAt: string;
}

export interface LabelMilestone {
  id: number;
  labelId: number;
  partnerId: number;
  name: string;
  dueDate: string | null;
  amount: number | null;
  isCompleted: boolean;
  completedAt: string | null;
  notes: string | null;
}

export interface Contact {
  id: number;
  partnerId: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
}

export interface Expense {
  id: number;
  projectId: number;
  expenseType: ExpenseType;
  amount: number;
  date: string;
  description: string | null;
  receiptUrl: string | null;
  createdBy: number;
  createdAt: string;
}

export interface Term {
  id: number;
  userId: number;
  title: string;
  monthlySalary: number | null;
  hourlyRate: number | null;
  startDate: string;
  endDate: string | null;
}
