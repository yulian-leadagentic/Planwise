import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { REALTIME_INVALIDATE, positiveInt, toRealtimeInvalidation } from './realtime.events';
import {
  REALTIME_ROUTES,
  RealtimeRouteRule,
  realtimeRouteKey,
  shouldResolveAfter,
  shouldResolveBefore,
} from './realtime-routes';
import { RealtimeTarget, RealtimeTargetsService } from './realtime-targets.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `{ success, data }` (ResponseInterceptor) → `data`; anything else as is. */
function unwrap(result: unknown): any {
  if (result && typeof result === 'object' && 'success' in result && 'data' in result) {
    return (result as { data: unknown }).data;
  }
  return result;
}

/**
 * QA6 P10 · PR-079 — after a successful write on a route listed in
 * REALTIME_ROUTES, emits `realtime.invalidate` (EventEmitter2) with the
 * ids of the project / task it touched; RealtimeGateway tells that
 * project's room. Registered globally (APP_INTERCEPTOR in RealtimeModule)
 * so no controller or service changes.
 *
 * It never affects the request: other routes pass straight through, a
 * failed write announces nothing (`tap` only sees success), and the
 * id lookups after the write run detached with their errors swallowed.
 */
@Injectable()
export class RealtimeInvalidationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RealtimeInvalidationInterceptor.name);

  constructor(
    private readonly targets: RealtimeTargetsService,
    private readonly events: EventEmitter2,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method = String(req?.method ?? '').toUpperCase();
    if (!WRITE_METHODS.has(method)) return next.handle();

    const key = realtimeRouteKey(
      method,
      Reflect.getMetadata(PATH_METADATA, context.getClass()),
      Reflect.getMetadata(PATH_METADATA, context.getHandler()),
    );
    const rule = REALTIME_ROUTES[key];
    if (!rule) return next.handle();

    const params = req.params ?? {};
    const body = req.body;

    // Before the write: the row is about to disappear (or move project).
    let beforeTargets: RealtimeTarget[] = [];
    if (shouldResolveBefore(rule, body)) {
      beforeTargets = await this.resolve(rule, params, body, undefined).catch((err) => {
        this.logger.debug(`realtime lookup before ${key} failed: ${(err as Error)?.message ?? err}`);
        return [];
      });
    }

    return next.handle().pipe(
      tap({
        next: (result) => {
          void this.announce(rule, key, params, body, unwrap(result), beforeTargets);
        },
      }),
    );
  }

  private async announce(
    rule: RealtimeRouteRule,
    key: string,
    params: Record<string, unknown>,
    body: unknown,
    result: unknown,
    beforeTargets: RealtimeTarget[],
  ): Promise<void> {
    try {
      const afterTargets = shouldResolveAfter(rule) ? await this.resolve(rule, params, body, result) : [];
      const seen = new Set<string>();
      for (const target of [...beforeTargets, ...afterTargets]) {
        const event = toRealtimeInvalidation({ type: rule.type, projectId: target.projectId, taskId: target.taskId });
        if (!event) continue;
        const dedupe = `${event.type}:${event.projectId}:${event.taskId ?? ''}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        this.events.emit(REALTIME_INVALIDATE, event);
      }
    } catch (err) {
      this.logger.debug(`realtime announce for ${key} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** The project(s) / task a request touched, per the rule's source. */
  async resolve(
    rule: RealtimeRouteRule,
    params: Record<string, unknown>,
    body: any,
    result: any,
  ): Promise<RealtimeTarget[]> {
    const one = (t: RealtimeTarget | null): RealtimeTarget[] => (t ? [t] : []);
    const source = rule.source;
    switch (source.kind) {
      case 'task': {
        const id = positiveInt(params[source.param]);
        return id == null ? [] : one(await this.targets.task(id));
      }
      case 'createdTask': {
        const taskId = positiveInt(result?.id);
        if (taskId == null) return [];
        if (result && 'projectId' in result) {
          // A personal task (projectId null) has no project room.
          const projectId = positiveInt(result.projectId);
          return projectId == null ? [] : [{ projectId, taskId }];
        }
        return one(await this.targets.task(taskId));
      }
      case 'checklistItem': {
        const id = positiveInt(params[source.param]);
        return id == null ? [] : one(await this.targets.checklistItem(id));
      }
      case 'attachment': {
        const id = positiveInt(params[source.param]);
        return id == null ? [] : one(await this.targets.attachment(id));
      }
      case 'zone': {
        const id = positiveInt(params[source.param]);
        return id == null ? [] : one(await this.targets.zone(id));
      }
      case 'deliverable': {
        const id = positiveInt(params[source.param]);
        return id == null ? [] : one(await this.targets.deliverable(id));
      }
      case 'project': {
        const projectId = positiveInt(params[source.param]);
        return projectId == null ? [] : [{ projectId }];
      }
      case 'bodyProject': {
        const projectId = positiveInt(body?.projectId) ?? positiveInt(result?.projectId);
        return projectId == null ? [] : [{ projectId }];
      }
      case 'bodyItems': {
        const items: unknown[] = Array.isArray(body?.items) ? body.items : [];
        const ids = items.map((it: any) => positiveInt(it?.id)).filter((id): id is number => id != null);
        return this.targets.projectsOf(source.entity, ids);
      }
    }
  }
}
