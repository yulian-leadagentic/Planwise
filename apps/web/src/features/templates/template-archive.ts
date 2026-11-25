/**
 * PR-053 (QA6, 2026-11-25) — archive templates instead of deleting them.
 *
 * `GET /templates` leaves archived templates out by default, so every
 * picker in the app (apply template, add deliverable, zone template
 * pickers, create task) hides them without any change of its own. The
 * templates pages add an Active / Archived view: `archived=only` lists
 * the archived ones so they can be restored. Delete stays only for a
 * template nobody uses; the server answers 409 TEMPLATE_IN_USE otherwise.
 */

export type TemplateListView = 'active' | 'archived';
export type ArchivableTemplateType = 'task_list' | 'zone';

/** Server `TemplateUsage` (templates.service.ts). */
export interface TemplateUsage {
  applied: number;
  projectDeliverables: number;
  projectTasks: number;
  composingTemplates: number;
  inUse: boolean;
}

interface TemplateLike {
  usageCount?: number | null;
  usage?: Partial<TemplateUsage> | null;
  archivedAt?: string | null;
}

/** List endpoint for a templates page view. Active = the picker list. */
export function templateListUrl(type: ArchivableTemplateType, view: TemplateListView): string {
  return view === 'archived' ? `/templates?type=${type}&archived=only` : `/templates?type=${type}`;
}

/**
 * React Query key for a templates page view. The active key is the one
 * the pickers already use, so an archive / restore refreshes both.
 */
export function templateListQueryKey(type: ArchivableTemplateType, view: TemplateListView) {
  return view === 'archived' ? ['templates', type, 'archived'] : ['templates', type];
}

export function isTemplateArchived(t: TemplateLike): boolean {
  return t.archivedAt != null;
}

/** In use = applied, or a project / another template points at it. */
export function isTemplateInUse(t: TemplateLike): boolean {
  if (t.usage && typeof t.usage.inUse === 'boolean') return t.usage.inUse;
  return Number(t.usageCount ?? 0) > 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short "where is it used" text, e.g. "applied 2 times, 1 other template". */
export function templateUsageText(t: TemplateLike): string {
  const u = t.usage;
  const parts: string[] = [];
  const applied = Number(u?.applied ?? t.usageCount ?? 0);
  if (applied > 0) parts.push(`applied ${plural(applied, 'time', 'times')}`);
  if ((u?.projectDeliverables ?? 0) > 0) {
    parts.push(plural(u!.projectDeliverables!, 'project deliverable', 'project deliverables'));
  }
  if ((u?.projectTasks ?? 0) > 0) parts.push(plural(u!.projectTasks!, 'project task', 'project tasks'));
  if ((u?.composingTemplates ?? 0) > 0) {
    parts.push(`used by ${plural(u!.composingTemplates!, 'other template', 'other templates')}`);
  }
  return parts.join(', ');
}

/** Why Delete is off for this row, or null when it may be deleted. */
export function deleteBlockedReason(t: TemplateLike): string | null {
  if (!isTemplateInUse(t)) return null;
  const where = templateUsageText(t);
  return `In use${where ? ` (${where})` : ''}. Archive it instead of deleting it.`;
}
