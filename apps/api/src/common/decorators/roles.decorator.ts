import { SetMetadata } from '@nestjs/common';

export interface RequiredPermission {
  module: string;
  action: 'read' | 'write' | 'delete';
}

export const ROLES_KEY = 'roles';

export const RequirePermissions = (...permissions: RequiredPermission[]) =>
  SetMetadata(ROLES_KEY, permissions);
