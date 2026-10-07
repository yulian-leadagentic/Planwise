import client from './client';

/**
 * Per-user key/value preference store (QA5 UI-13).
 *
 * Backs by `GET/PUT /api/v1/users/me/preferences/:key` — the server
 * stores one JSON blob per `(user, key)` and never interprets its
 * shape, so each caller owns the type of its own `value`.
 *
 * Keys are opaque dotted strings. See
 * `apps/api/src/modules/user-preferences/user-preferences.controller.ts`
 * for the full key registry; current entries:
 *
 *   • `execution-board.column-order`
 *       → `{ [deliverableName: string]: number }` — the per-user
 *         deliverable column order typed into the "All Deliverables"
 *         filter on the Execution Board.
 */
export const userPreferencesApi = {
  /** Read one preference. `value` is `null` when the user has none. */
  get: <T = unknown>(key: string) =>
    client
      .get<{ success: true; data: { key: string; value: T | null } }>(
        `/users/me/preferences/${encodeURIComponent(key)}`,
      )
      .then((r) => r.data.data),

  /** Overwrite the whole blob under `key`. */
  put: <T = unknown>(key: string, value: T) =>
    client
      .put<{ success: true; data: { key: string; value: T } }>(
        `/users/me/preferences/${encodeURIComponent(key)}`,
        { value },
      )
      .then((r) => r.data.data),
};

/** Stable key constants — keep this list in sync with the backend. */
export const USER_PREF_KEYS = {
  EXECUTION_BOARD_COLUMN_ORDER: 'execution-board.column-order',
} as const;

/** The shape stored under `execution-board.column-order`. */
export type ExecutionBoardColumnOrder = Record<string, number>;
