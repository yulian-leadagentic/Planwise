/**
 * Shared types for project-detail-page and its sub-components (Team tab,
 * pickers, info tab, etc.). Extracted verbatim from project-detail-page.tsx.
 */

export type Tab = 'info' | 'planning' | 'schedule' | 'kanban' | 'execution' | 'team' | 'cost' | 'files' | 'discussion' | 'activity';

export interface User {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  avatarUrl?: string | null;
  position?: string | null;
}

export interface ProjectMember {
  id: number;
  projectId: number;
  userId: number;
  role: string | null;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  };
  createdAt: string;
}

export interface ProjectTeamPerson {
  relationshipId: number;
  businessPartnerId: number;
  userId: number | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  roleInContext: string | null;
  // Customer contacts may carry which rel-type wired them to the customer.
  relationshipTypeCode?: string;
  relationshipTypeName?: string;
}

export interface ProjectRoleTypeRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  allowedPartnerKind: 'person' | 'organization' | 'any';
  requiredPartnerRoleCode: string | null;
  // Profession IDs the party must hold AT LEAST ONE OF. When present we
  // filter the assignment dropdown to people who satisfy this — otherwise
  // the backend rejects the POST with "must hold one of these job titles".
  requiredProfessionIds: number[] | null;
  isPrimaryRequired: boolean;
  sortOrder: number;
  isSystem: boolean;
}

export interface ProjectRoleAssignment {
  id: number;
  role: ProjectRoleTypeRow;
  party: {
    id: number;
    partnerType: 'person' | 'organization';
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
  isPrimary: boolean;
  titleInProject: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: string;
}

export interface ProjectTeamData {
  customer: {
    relationshipId: number;
    organizationId: number;
    displayName: string;
    email: string | null;
    phone: string | null;
  } | null;
  customerContacts: ProjectTeamPerson[];
  projectTeam: ProjectTeamPerson[];
  roleAssignments: ProjectRoleAssignment[];
}

export type PickerMode = 'customer-contact' | 'supplier' | 'supplier-worker';
