import { usePermissions } from '@/hooks/use-permissions';
import { TaskChecklist } from '@/features/tasks/task-checklist';
import { TaskProjectInfoBlock } from './task-project-info-block';
import { DeliverableTargetRow } from './deliverable-target-row';
import { AssigneeManager } from './assignee-manager';
import { EditableTextarea, EditableNumber, EditableDate, FieldRow } from './editable-fields';

export function TaskDetailsTab({ task, onUpdate }: { task: any; onUpdate: (field: string, value: any) => void }) {
  const dueDateValue = task.endDate ? String(task.endDate).slice(0, 10) : '';
  // Permission-gated due-date editing. Three accepted sources:
  //   - Admin (roleId=1) — always
  //   - tasks:write — general edit power
  //   - tasks/edit-due-date:write — the new fine-grained option requested
  //     2026-06-17, lets an admin grant exactly "can change due dates"
  //     without handing out full tasks:write.
  // First match wins; matching against either keeps existing roles
  // working with no migration needed.
  const { can, isAdmin } = usePermissions();
  const canEditDueDate = isAdmin || can('tasks', 'write') || can('tasks/edit-due-date', 'write');
  return (
    <div className="space-y-4">
      {/* Project Info leads the tab — the parent project's metadata is the
          primary content here. */}
      {task.projectId && (
        <TaskProjectInfoBlock
          projectId={task.projectId}
          backLabel={task.code ? `task ${task.code}` : `task #${task.id}`}
        />
      )}

      {/* Deliverable target date (Tier E #10). Resolved from the
          (zone × deliverable) target set on the Deliverable Planning
          screen; falls back to the deliverable-level target. Read-only
          here — the Deliverable Planning tab is where PMs edit it.
          The task's own Due Date below can differ (assignee or manager
          overrides), and if it does we show a small "manually set"
          indicator so the user knows the two aren't tied anymore. */}
      <DeliverableTargetRow task={task} />

      {/* Editable Due Date — gated on tasks:write. Without permission, we
          render a read-only span so users can still SEE the due date but
          can't change it. */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-20 shrink-0">Due Date</label>
        {canEditDueDate ? (
          <input
            type="date"
            key={`due-${task.id}-${dueDateValue}`}
            defaultValue={dueDateValue}
            onBlur={(e) => {
              const v = e.target.value;
              // Empty → null (clear the date). Otherwise pass the ISO yyyy-mm-dd
              // through unchanged; the API's @IsDateString accepts it as-is.
              if (v !== dueDateValue) onUpdate('endDate', v || null);
            }}
            className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
          />
        ) : (
          <span className="text-sm text-slate-700 dark:text-slate-200">
            {dueDateValue || <span className="text-slate-400 dark:text-slate-500 italic">no due date</span>}
          </span>
        )}
        {task.dueDateOverridden && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5" title="This date was manually set and won't be overwritten by Deliverable target changes">
            manually set
          </span>
        )}
      </div>

      {/* Description — ported from task-detail-page. Click-to-edit
          textarea, autosaves on blur. Full-width so long descriptions
          get room to breathe. */}
      <div className="space-y-1">
        <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">Description</label>
        <EditableTextarea
          value={task.description ?? ''}
          onSave={(v) => onUpdate('description', v)}
          placeholder="Click to add a description"
        />
      </div>

      {/* Numeric + date fields ported from task-detail-page. Progress
          drives the completion pill on the health banner; Budget Hours
          drives the loggedHours/estHours ratio; Budget Amount is the
          money-side counterpart. Est. Start (planning forecast) and
          Start (actual) live here because both surfaces read them. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
        <FieldRow label="Progress">
          <EditableNumber
            value={task.completionPct ?? 0}
            onSave={(v) => onUpdate('completionPct', v)}
            min={0}
            max={100}
            suffix="%"
          />
        </FieldRow>
        <FieldRow label="Budget Hours">
          <EditableNumber
            value={task.budgetHours}
            onSave={(v) => onUpdate('budgetHours', v)}
            min={0}
            suffix="h"
          />
        </FieldRow>
        <FieldRow label="Budget Amount">
          <EditableNumber
            value={task.budgetAmount}
            onSave={(v) => onUpdate('budgetAmount', v)}
            min={0}
          />
        </FieldRow>
        <FieldRow label="Est. Start">
          <EditableDate
            value={task.estimatedStartDate}
            onSave={(v) => onUpdate('estimatedStartDate', v)}
          />
        </FieldRow>
        <FieldRow label="Start">
          <EditableDate
            value={task.startDate}
            onSave={(v) => onUpdate('startDate', v)}
          />
        </FieldRow>
      </div>

      <AssigneeManager
        taskId={task.id}
        projectId={task.projectId ?? null}
        assignees={task.assignees}
      />

      {/* Checklist (todo) — added per the BM mapping meeting decision that
          personal-task style items belong INSIDE the task, not as separate
          tasks. No due date, no hours. Renders inside the Details tab so
          the assignee + dates context is visible right above. */}
      <TaskChecklist taskId={task.id} />

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        {/* Zone row: name for zoned tasks, explicit "Project Root" for
            zoneId=null tasks so the drawer doesn't silently hide the
            zone information (which made it look like a field was just
            missing rather than intentionally unscoped). */}
        <div>
          <span className="text-slate-400 dark:text-slate-500">Zone:</span>{' '}
          {task.zone ? (
            <span className="text-slate-700 dark:text-slate-200 font-medium">{task.zone.name}</span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400 italic">Project Root</span>
          )}
        </div>
        {task.phase && <div><span className="text-slate-400 dark:text-slate-500">Service:</span> <span className="text-slate-700 dark:text-slate-200 font-medium">{task.phase.name}</span></div>}
        {task.serviceType && <div><span className="text-slate-400 dark:text-slate-500">Deliverable:</span> <span className="text-slate-700 dark:text-slate-200 font-medium">{task.serviceType.name}</span></div>}
      </div>
    </div>
  );
}
