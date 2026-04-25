import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, OWN_DATA_KEY, RequiredPermission } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<RequiredPermission[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isOwnData = this.reflector.getAllAndOverride<boolean>(OWN_DATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.roleModules) {
      if (isOwnData) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    const findEntry = (key: string) => {
      const lc = key.toLowerCase();
      return user.roleModules.find((rm: any) => {
        const route = rm.module?.route || '';
        const name = rm.module?.name?.toLowerCase() || '';
        return route === key || route === `/${key}` || name === lc;
      });
    };

    const hasPermission = requiredPermissions.every((required) => {
      // Most-specific match first; fall back to parent path so a role with
      // permission on /admin still satisfies /admin/roles unless an explicit
      // /admin/roles entry exists and denies it.
      for (const candidate of expandModule(required.module)) {
        const userModule = findEntry(candidate);
        if (!userModule) continue;
        switch (required.action) {
          case 'read': return userModule.canRead;
          case 'write': return userModule.canWrite;
          case 'delete': return userModule.canDelete;
          case 'approve': return userModule.canApprove;
          case 'export': return userModule.canExport;
          default: return false;
        }
      }
      return false;
    });

    if (!hasPermission) {
      if (isOwnData) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}

function expandModule(module: string): string[] {
  const candidates = [module];
  const path = module.startsWith('/') ? module : `/${module}`;
  const parts = path.split('/').filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    candidates.push(parts.slice(0, i).join('/'));
  }
  return candidates;
}
