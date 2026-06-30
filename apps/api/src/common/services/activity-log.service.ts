/**
 * Activity logging — typed, semantic wrappers around `prisma.activityLog`.
 *
 * Services that perform user-facing writes call into this from inside
 * their existing transactions / handlers. The point isn't "log every
 * HTTP request" (the generic AuditInterceptor does that for a few
 * modules and produces noise like "update task"); the point is
 * audit-trail entries a human can read at-a-glance —
 *
 *    "Yulian changed status of TSK-1016 from To Do to In Progress"
 *    "Shifi added Alex Isakov as assignee on TSK-742"
 *    "Yulian deleted file 'plan-r24.pdf' from project 250116"
 *
 * Every helper requires (or attempts to resolve) the owning projectId
 * so the per-project Activity tab can query by it directly via the
 * (project_id, created_at) composite index. Falling back to null is
 * fine for global actions (auth, admin) — those still show up in the
 * admin-wide /admin/activity-logs view.
 *
 * All helpers swallow their own errors. An audit-log failure must
 * NEVER fail the underlying business write — losing a row in the log
 * is recoverable; losing a task update because the log table is full
 * is not.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ActivityCategory, ActivitySeverity } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface LogCommonInput {
  actorUserId?: number | null;
  projectId?: number | null;
  entityId?: number | null;
  entityName?: string | null;
  ipAddress?: string | null;
  /** Structured payload (e.g. before/after, ids, counts). Optional. */
  changes?: Prisma.InputJsonValue | null;
  /** Free-form extras. Optional. */
  metadata?: Prisma.InputJsonValue | null;
}

@Injectable()
export class ActivityLogService {
  private readonly log = new Logger(ActivityLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Low-level entry point. Prefer the per-domain helpers below — they
   * fix `category` + `entityType` so the consuming UI can render
   * appropriate icons without grepping the description.
   */
  async write(params: {
    category: ActivityCategory;
    action: string;
    description: string;
    entityType?: string | null;
    severity?: ActivitySeverity;
  } & LogCommonInput): Promise<void> {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: params.actorUserId ?? null,
          projectId: params.projectId ?? null,
          category: params.category,
          action: params.action,
          severity: params.severity ?? 'info',
          entityType: params.entityType ?? null,
          entityId: params.entityId ?? null,
          entityName: params.entityName ?? null,
          description: params.description,
          changes: params.changes ?? Prisma.JsonNull,
          metadata: params.metadata ?? Prisma.JsonNull,
          ipAddress: params.ipAddress ?? null,
        },
      });
    } catch (err) {
      // Logging is best-effort. Surface to the application log so a
      // chronically failing audit table gets noticed, but never throw.
      this.log.warn(
        `activity log write failed: ${(err as Error).message}; payload=${params.category}/${params.action}`,
      );
    }
  }

  // ─── Project ──────────────────────────────────────────────────────

  async logProjectCreated(input: LogCommonInput & { projectName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'create',
      entityType: 'project',
      entityName: input.projectName,
      description: `Created project "${input.projectName}"`,
      ...input,
    });
  }

  async logProjectUpdated(input: LogCommonInput & { projectName: string; changedFields: string[] }): Promise<void> {
    const fields = input.changedFields.join(', ') || 'fields';
    await this.write({
      category: 'project',
      action: 'update',
      entityType: 'project',
      entityName: input.projectName,
      description: `Updated project "${input.projectName}" — ${fields}`,
      ...input,
    });
  }

  async logProjectDeleted(input: LogCommonInput & { projectName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'delete',
      entityType: 'project',
      entityName: input.projectName,
      description: `Deleted project "${input.projectName}"`,
      severity: 'warn',
      ...input,
    });
  }

  async logProjectMemberAdded(input: LogCommonInput & { projectName: string; memberName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'member_add',
      entityType: 'project_member',
      entityName: input.memberName,
      description: `Added ${input.memberName} to project team`,
      ...input,
    });
  }

  async logProjectMemberRemoved(input: LogCommonInput & { projectName: string; memberName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'member_remove',
      entityType: 'project_member',
      entityName: input.memberName,
      description: `Removed ${input.memberName} from project team`,
      ...input,
    });
  }

  async logRoleAssigned(input: LogCommonInput & { roleName: string; partyName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'role_assign',
      entityType: 'project_partner_role',
      entityName: input.partyName,
      description: `Assigned ${input.partyName} as ${input.roleName}`,
      ...input,
    });
  }

  async logRoleEnded(input: LogCommonInput & { roleName: string; partyName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'role_end',
      entityType: 'project_partner_role',
      entityName: input.partyName,
      description: `Ended ${input.roleName} assignment for ${input.partyName}`,
      ...input,
    });
  }

  // ─── Task ─────────────────────────────────────────────────────────

  async logTaskCreated(input: LogCommonInput & { taskCode: string | null; taskName: string }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode} "${input.taskName}"` : `"${input.taskName}"`;
    await this.write({
      category: 'task',
      action: 'create',
      entityType: 'task',
      entityName: input.taskName,
      description: `Created task ${label}`,
      ...input,
    });
  }

  async logTaskUpdated(input: LogCommonInput & { taskCode: string | null; taskName: string; changedFields: string[] }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode}` : `"${input.taskName}"`;
    const fields = input.changedFields.join(', ') || 'fields';
    await this.write({
      category: 'task',
      action: 'update',
      entityType: 'task',
      entityName: input.taskName,
      description: `Updated ${label} — ${fields}`,
      ...input,
    });
  }

  async logTaskStatusChange(input: LogCommonInput & { taskCode: string | null; taskName: string; oldStatus: string; newStatus: string }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode}` : `"${input.taskName}"`;
    await this.write({
      category: 'task',
      action: 'status_change',
      entityType: 'task',
      entityName: input.taskName,
      description: `${label} status: ${input.oldStatus} → ${input.newStatus}`,
      ...input,
    });
  }

  async logTaskDeleted(input: LogCommonInput & { taskCode: string | null; taskName: string }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode} "${input.taskName}"` : `"${input.taskName}"`;
    await this.write({
      category: 'task',
      action: 'delete',
      entityType: 'task',
      entityName: input.taskName,
      description: `Deleted task ${label}`,
      severity: 'warn',
      ...input,
    });
  }

  async logAssigneeAdded(input: LogCommonInput & { taskCode: string | null; taskName: string; assigneeName: string }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode}` : `"${input.taskName}"`;
    await this.write({
      category: 'task',
      action: 'assignee_add',
      entityType: 'task_assignee',
      entityName: input.assigneeName,
      description: `Assigned ${input.assigneeName} to ${label}`,
      ...input,
    });
  }

  async logAssigneeRemoved(input: LogCommonInput & { taskCode: string | null; taskName: string; assigneeName: string }): Promise<void> {
    const label = input.taskCode ? `${input.taskCode}` : `"${input.taskName}"`;
    await this.write({
      category: 'task',
      action: 'assignee_remove',
      entityType: 'task_assignee',
      entityName: input.assigneeName,
      description: `Unassigned ${input.assigneeName} from ${label}`,
      ...input,
    });
  }

  async logTaskAttachmentAdded(input: LogCommonInput & { taskCode: string | null; fileName: string }): Promise<void> {
    const label = input.taskCode ?? 'task';
    await this.write({
      category: 'task',
      action: 'attachment_add',
      entityType: 'task_attachment',
      entityName: input.fileName,
      description: `Attached "${input.fileName}" to ${label}`,
      ...input,
    });
  }

  async logTaskAttachmentRemoved(input: LogCommonInput & { taskCode: string | null; fileName: string }): Promise<void> {
    const label = input.taskCode ?? 'task';
    await this.write({
      category: 'task',
      action: 'attachment_remove',
      entityType: 'task_attachment',
      entityName: input.fileName,
      description: `Removed "${input.fileName}" from ${label}`,
      ...input,
    });
  }

  // ─── Time entries ─────────────────────────────────────────────────

  async logTimeEntryCreated(input: LogCommonInput & { hours: number; taskName?: string | null }): Promise<void> {
    const onTask = input.taskName ? ` on "${input.taskName}"` : '';
    await this.write({
      category: 'time',
      action: 'create',
      entityType: 'time_entry',
      description: `Logged ${input.hours.toFixed(2)}h${onTask}`,
      ...input,
    });
  }

  async logTimeEntryDeleted(input: LogCommonInput & { hours: number; taskName?: string | null }): Promise<void> {
    const onTask = input.taskName ? ` from "${input.taskName}"` : '';
    await this.write({
      category: 'time',
      action: 'delete',
      entityType: 'time_entry',
      description: `Deleted ${input.hours.toFixed(2)}h time entry${onTask}`,
      severity: 'warn',
      ...input,
    });
  }

  // ─── Project files ────────────────────────────────────────────────

  async logProjectFileAdded(input: LogCommonInput & { fileName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'file_add',
      entityType: 'project_file',
      entityName: input.fileName,
      description: `Added file "${input.fileName}" to project`,
      ...input,
    });
  }

  async logProjectFileRemoved(input: LogCommonInput & { fileName: string }): Promise<void> {
    await this.write({
      category: 'project',
      action: 'file_remove',
      entityType: 'project_file',
      entityName: input.fileName,
      description: `Removed file "${input.fileName}" from project`,
      severity: 'warn',
      ...input,
    });
  }
}
