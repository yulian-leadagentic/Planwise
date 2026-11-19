import { Prisma } from '@prisma/client';

/**
 * TaskDependency rows survive a soft task delete on purpose: the prisma
 * soft-delete middleware turns `task.delete` into an update, and a
 * restore brings the edges back. That middleware only filters the
 * top-level query — nested includes of `dependencies` / `dependedBy`
 * still return edges whose other end is deleted. Every read that ships
 * or walks edges must drop those, with these `where` fragments on the
 * relation include:
 *
 *   dependencies: { where: LIVE_PREDECESSOR_EDGE, ... }  // this task's predecessors
 *   dependedBy:   { where: LIVE_SUCCESSOR_EDGE, ... }    // this task's successors
 */
export const LIVE_PREDECESSOR_EDGE: Prisma.TaskDependencyWhereInput = {
  dependsOn: { deletedAt: null },
};

export const LIVE_SUCCESSOR_EDGE: Prisma.TaskDependencyWhereInput = {
  task: { deletedAt: null },
};

/** Both ends live — for queries over TaskDependency rows directly. */
export const LIVE_EDGE: Prisma.TaskDependencyWhereInput = {
  task: { deletedAt: null },
  dependsOn: { deletedAt: null },
};
