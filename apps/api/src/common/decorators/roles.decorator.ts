import { SetMetadata } from '@nestjs/common';

export interface RequiredPermission {
  module: string;
  action: 'read' | 'write' | 'delete' | 'approve' | 'export';
}

export const ROLES_KEY = 'roles';
export const OWN_DATA_KEY = 'own_data';

export const RequirePermissions = (...permissions: RequiredPermission[]) =>
  SetMetadata(ROLES_KEY, permissions);

export const OwnData = () => SetMetadata(OWN_DATA_KEY, true);
