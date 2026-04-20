import type { ReactNode } from 'react';
import { usePermissions } from '@/hooks/use-permissions';

type PermAction = 'read' | 'write' | 'delete' | 'approve' | 'export';

interface PermissionGateProps {
  module: string;
  action: PermAction;
  children: ReactNode;
  /** Rendered when permission is denied. Defaults to null (hidden). */
  fallback?: ReactNode;
}

/**
 * Conditionally renders children based on the current user's RBAC
 * permissions. Use this to hide/show buttons, sections, or actions.
 *
 * Usage:
 *   <PermissionGate module="tasks" action="write">
 *     <button>Create Task</button>
 *   </PermissionGate>
 *
 *   <PermissionGate module="reports" action="export" fallback={<span>No export access</span>}>
 *     <ExportButton />
 *   </PermissionGate>
 */
export function PermissionGate({ module, action, children, fallback = null }: PermissionGateProps) {
  const { can, isAdmin } = usePermissions();
  if (isAdmin || can(module, action)) return <>{children}</>;
  return <>{fallback}</>;
}
