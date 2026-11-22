import client from './client';
import type { ApiResponse, User, UserListItem, PaginationQuery } from '@/types';

export interface UserQuery extends PaginationQuery {
  userType?: string;
  /**
   * Active filter. The backend defaults to `true` (active only) when this
   * is omitted — that's what every picker in the app relies on. Pass
   * `false` for inactive-only or `'all'` to include both (admin People
   * page only).
   */
  isActive?: boolean | 'all';
  search?: string;
  roleId?: number;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Optional Hebrew rendering — bilingual search matches this too. T3.3. */
  firstNameHe?: string;
  lastNameHe?: string;
  phone?: string;
  roleId: number;
  userType: string;
  position?: string;
  /**
   * Retire-User.department Step 2/3 (2026-09-28) — free-text
   * `department` is gone from the write DTO on the backend. Send
   * `orgUnitId` (OrgUnit tree id) instead. Step 3/3 drops the column.
   */
  orgUnitId?: number | null;
  companyName?: string;
  taxId?: string;
  address?: string;
  website?: string;
}

/** The API's largest page (`PaginationQueryDto.perPage` @Max). */
const MAX_PER_PAGE = 1000;

export const usersApi = {
  list: (params?: UserQuery) =>
    client.get<ApiResponse<UserListItem[]>>('/users', { params }).then((r) => r.data),

  /**
   * Every user matching `params`, all pages. A bare `GET /users` returns
   * only the first page (20 rows), which silently hid most people from
   * the pickers and the People page — this pages through at the API's
   * maximum page size until `meta.total` is reached.
   */
  listAll: async (params: Omit<UserQuery, 'page' | 'perPage'> = {}): Promise<UserListItem[]> => {
    const all: UserListItem[] = [];
    // Bounded: 50 pages × 1000 rows is far beyond any real directory.
    for (let page = 1; page <= 50; page++) {
      const body = await client
        .get<ApiResponse<UserListItem[]>>('/users', { params: { ...params, perPage: MAX_PER_PAGE, page } })
        .then((r) => r.data);
      const rows: UserListItem[] = Array.isArray(body?.data) ? body.data : [];
      all.push(...rows);
      const total: unknown = body?.meta?.total;
      if (rows.length < MAX_PER_PAGE || (typeof total === 'number' && all.length >= total)) break;
    }
    return all;
  },

  /**
   * Every active user, for pickers that search client-side.
   * Directory-tier fields only for most callers (permissions round 3),
   * which is all a picker needs.
   */
  listAllActive: (): Promise<UserListItem[]> => usersApi.listAll({ isActive: true }),

  get: (id: number) =>
    client.get<ApiResponse<User>>(`/users/${id}`).then((r) => r.data.data),

  create: (payload: CreateUserPayload) =>
    client.post<ApiResponse<User>>('/users', payload).then((r) => r.data.data),

  update: (id: number, payload: Partial<CreateUserPayload>) =>
    client.patch<ApiResponse<User>>(`/users/${id}`, payload).then((r) => r.data.data),

  delete: (id: number) =>
    client.delete(`/users/${id}`).then((r) => r.data),
};
