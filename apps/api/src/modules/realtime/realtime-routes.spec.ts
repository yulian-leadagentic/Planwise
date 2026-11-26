/**
 * QA6 P10 · PR-079 — REALTIME_ROUTES must name real routes. A renamed
 * route or param would silently stop announcing; this spec reads the
 * Nest decorators of the controllers and fails instead.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { REALTIME_ROUTES, realtimeRouteKey } from './realtime-routes';
import { TasksController } from '../tasks/tasks.controller';
import { ProjectsController } from '../projects/projects.controller';
import { ZonesController } from '../zones/zones.controller';
import { ProjectDeliverablesController } from '../project-deliverables/project-deliverables.controller';
import { SchedulingController } from '../scheduling/scheduling.controller';
import { ExecutionPlanningController } from '../execution-planning/execution-planning.controller';
import { ProjectStatusBoardController } from '../project-status-board/project-status-board.controller';
import { WorkloadAssignController } from '../workload-assign/workload-assign.controller';

const CONTROLLERS = [
  TasksController,
  ProjectsController,
  ZonesController,
  ProjectDeliverablesController,
  SchedulingController,
  ExecutionPlanningController,
  ProjectStatusBoardController,
  WorkloadAssignController,
];

function declaredRoutes(): Set<string> {
  const keys = new Set<string>();
  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata(PATH_METADATA, controller);
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as any)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (path === undefined || method === undefined) continue;
      keys.add(realtimeRouteKey(RequestMethod[method], base, path));
    }
  }
  return keys;
}

describe('REALTIME_ROUTES', () => {
  const declared = declaredRoutes();

  it.each(Object.keys(REALTIME_ROUTES))('%s is a real route', (key) => {
    expect(declared).toContain(key);
  });

  it.each(Object.entries(REALTIME_ROUTES))('%s reads a param the route has', (key, rule) => {
    const param = (rule.source as { param?: string }).param;
    if (param) expect(key.split(/[\s/]/)).toContain(`:${param}`);
  });

  it('keys are built the way Nest spells routes', () => {
    expect(realtimeRouteKey('post', 'tasks', '/')).toBe('POST tasks');
    expect(realtimeRouteKey('PATCH', '/tasks/', ':id/')).toBe('PATCH tasks/:id');
    expect(realtimeRouteKey('POST', '', 'scheduling/projects/:projectId/apply-reviewed')).toBe(
      'POST scheduling/projects/:projectId/apply-reviewed',
    );
  });

  it('only writes that delete a row resolve before the handler', () => {
    for (const [key, rule] of Object.entries(REALTIME_ROUTES)) {
      if (rule.after === false) expect(key.startsWith('DELETE ')).toBe(true);
    }
  });
});
