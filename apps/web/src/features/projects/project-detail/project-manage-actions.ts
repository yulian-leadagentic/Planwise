/**
 * QA6 round 2 (26.11) · which manage actions the project header offers.
 *
 * Round 4 rule: managing a project (edit / settings, status, categories,
 * close / reopen, delete) is leader or Admin only. GET /projects/:id
 * returns that answer as `canManage` (the server's assertProjectManage).
 * The routes also need the module permission: projects:write, and
 * projects:delete for delete. An Admin passes those (RolesGuard bypass),
 * so the web mirrors that.
 *
 * Everyone else gets no control at all: hidden, not disabled. A payload
 * without `canManage` (an older API) offers none; the API would refuse.
 */
export type ProjectManageActions = {
  /** The pencil to /projects/:id/edit (settings, leader, org unit). */
  edit: boolean;
  /** The status pill opens a menu (else a read-only pill). */
  changeStatus: boolean;
  /** The category chips open a menu (else read-only chips). */
  changeCategories: boolean;
  /** "Close project" / "Re-open". */
  closeOrReopen: boolean;
  /** "Delete". */
  delete: boolean;
};

export function projectManageActions(
  project: { canManage?: unknown } | null | undefined,
  perms: { isAdmin: boolean; can: (module: string, action: 'write' | 'delete') => boolean },
): ProjectManageActions {
  const manage = project?.canManage === true;
  const write = manage && (perms.isAdmin || perms.can('projects', 'write'));
  return {
    edit: write,
    changeStatus: write,
    changeCategories: write,
    closeOrReopen: write,
    delete: manage && (perms.isAdmin || perms.can('projects', 'delete')),
  };
}
