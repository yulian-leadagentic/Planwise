import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;
    const url = request.url;
    const user = request.user;

    // Only audit write operations
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next.handle();
    }

    const startBody = { ...request.body };

    return next.handle().pipe(
      tap(async (responseData) => {
        try {
          const action = this.getAction(method);
          const { entityType, entityId, entityName } = this.extractEntityInfo(url, responseData);

          await this.prisma.activityLog.create({
            data: {
              userId: user?.id || null,
              sessionId: request.headers['x-session-id'] || null,
              category: this.getCategory(url),
              action,
              severity: 'info',
              entityType,
              entityId,
              entityName,
              description: `${action} ${entityType || 'resource'}`,
              changes: method === 'PATCH' || method === 'PUT' ? startBody : null,
              metadata: null,
              ipAddress: request.ip || null,
            },
          });
        } catch {
          // Silently fail - audit should not break the request
        }
      }),
    );
  }

  private getAction(method: string): string {
    switch (method) {
      case 'POST':
        return 'create';
      case 'PUT':
      case 'PATCH':
        return 'update';
      case 'DELETE':
        return 'delete';
      default:
        return method.toLowerCase();
    }
  }

  private getCategory(url: string): any {
    if (url.includes('/auth')) return 'auth';
    if (url.includes('/projects')) return 'project';
    if (url.includes('/tasks')) return 'task';
    if (url.includes('/time') || url.includes('/clock')) return 'time';
    if (url.includes('/contracts') || url.includes('/billings')) return 'contract';
    if (url.includes('/users')) return 'user';
    if (url.includes('/admin') || url.includes('/roles')) return 'admin';
    return 'system';
  }

  private extractEntityInfo(
    url: string,
    responseData: any,
  ): { entityType: string | null; entityId: number | null; entityName: string | null } {
    const segments = url.split('/').filter(Boolean);
    const entityType = segments.find((s) => !Number(s) && s !== 'api' && s !== 'v1') || null;

    let entityId: number | null = null;
    let entityName: string | null = null;

    if (responseData) {
      const data = responseData.data || responseData;
      if (data?.id) entityId = data.id;
      if (data?.name) entityName = data.name;
    }

    return { entityType, entityId, entityName };
  }
}
