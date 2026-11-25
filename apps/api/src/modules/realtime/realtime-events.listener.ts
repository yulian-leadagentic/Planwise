import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { REALTIME_INVALIDATE, positiveInt, toRealtimeInvalidation } from './realtime.events';
import { RealtimeTargetsService } from './realtime-targets.service';

/**
 * Bridges the domain events that already exist (emitted by
 * tasks.service.ts, also consumed by SystemMessagesListener) into
 * `realtime.invalidate`. The HTTP interceptor announces the same writes;
 * RealtimeGateway merges duplicates inside its flush window, so a status
 * change reaches each tab once.
 */
@Injectable()
export class RealtimeEventsListener {
  private readonly logger = new Logger(RealtimeEventsListener.name);

  constructor(
    private readonly events: EventEmitter2,
    private readonly targets: RealtimeTargetsService,
  ) {}

  @OnEvent('task.status.changed')
  handleTaskStatusChanged(payload: { taskId?: unknown; projectId?: unknown }): void {
    const event = toRealtimeInvalidation({ type: 'task.updated', projectId: payload?.projectId, taskId: payload?.taskId });
    // projectId null = a personal task: no project room to tell.
    if (event) this.events.emit(REALTIME_INVALIDATE, event);
  }

  @OnEvent('task.assignee.added')
  async handleTaskAssigneeAdded(payload: { taskId?: unknown }): Promise<void> {
    const taskId = positiveInt(payload?.taskId);
    if (taskId == null) return;
    try {
      const target = await this.targets.task(taskId);
      if (target) this.events.emit(REALTIME_INVALIDATE, { type: 'task.updated', ...target });
    } catch (err) {
      this.logger.debug(`realtime lookup for task ${taskId} failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
