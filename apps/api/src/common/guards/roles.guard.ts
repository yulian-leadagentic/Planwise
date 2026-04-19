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

    const hasPermission = requiredPermissions.every((required) => {
      const userModule = user.roleModules.find(
        (rm: any) => {
          const route = rm.module?.route || '';
          const moduleName = rm.module?.name?.toLowerCase() || '';
          return route === required.module || route === `/${required.module}` || moduleName === required.module;
        },
      );
      if (!userModule) return false;

      switch (required.action) {
        case 'read':
          return userModule.canRead;
        case 'write':
          return userModule.canWrite;
        case 'delete':
          return userModule.canDelete;
        case 'approve':
          return userModule.canApprove;
        case 'export':
          return userModule.canExport;
        default:
          return false;
      }
    });

    if (!hasPermission) {
      if (isOwnData) return true;
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
