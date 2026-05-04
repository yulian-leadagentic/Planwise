import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { buildCatalogMap, resolveBudget as resolveBudgetUtil } from './zones.util';

@Injectable()
export class ZonesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Loads the Task Catalog and returns a map of code → { defaultBudgetHours, defaultBudgetAmount }.
   * Used as a fallback when template tasks don't have their own budget values set.
   *
   * Accepts an optional transaction client so callers inside $transaction
   * read a consistent snapshot of the catalog (no mid-tx drift).
   */
  private async loadCatalogMap(tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const catalog = await client.template.findFirst({
      where: { code: '__TASK_CATALOG__' },
      include: { templateTasks: true },
    });
    return buildCatalogMap(catalog?.templateTasks ?? []);
  }

  /**
   * Resolves budget for a task: template task value OR catalog fallback by code.
   * Thin wrapper around the pure `resolveBudget` utility.
   */
  private resolveBudget(
    tt: { code?: string | null; defaultBudgetHours?: any; defaultBudgetAmount?: any },
    catalog: Map<string, { hours: any; amount: any }>,
  ) {
    return resolveBudgetUtil(tt, catalog);
  }

  async findAll(projectId: number) {
    return this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async findTree(projectId: number) {
    const zones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });

    const map = new Map<number, any>();
    const roots: any[] = [];

    for (const zone of zones) {
      map.set(zone.id, { ...zone, children: [] });
    }

    for (const zone of zones) {
      const node = map.get(zone.id);
      if (zone.parentId && map.has(zone.parentId)) {
        map.get(zone.parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async findOne(id: number) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
      include: {
        children: { where: { deletedAt: null } },
        zoneServiceTypes: { include: { serviceType: true } },
        tasks: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    return zone;
  }

  async create(dto: CreateZoneDto) {
    let path = '';
    let depth = 0;

    if (dto.parentId) {
      const parent = await this.prisma.zone.findFirst({
        where: { id: dto.parentId, deletedAt: null },
      });
      if (!parent) {
        throw new NotFoundException('Parent zone not found');
      }
      path = parent.path;
      depth = parent.depth + 1;
    }

    const zone = await this.prisma.zone.create({
      data: {
        projectId: dto.projectId,
        parentId: dto.parentId ?? null,
        zoneType: (dto as any).zoneType || "zone",
        name: dto.name,
        code: dto.code,
        areaSqm: dto.areaSqm,
        description: dto.description,
        isTypical: dto.isTypical ?? false,
        typicalCount: dto.typicalCount ?? 1,
        path: '', // placeholder, updated below
        depth,
      },
      
    });

    // Update path to include own id
    const fullPath = path ? `${path}/${zone.id}` : `${zone.id}`;
    await this.prisma.zone.update({
      where: { id: zone.id },
      data: { path: fullPath },
    });

    return { ...zone, path: fullPath };
  }

  async update(id: number, dto: UpdateZoneDto) {
    await this.findOne(id);

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.zoneType !== undefined) data.zoneType = dto.zoneType;
    if (dto.areaSqm !== undefined) data.areaSqm = dto.areaSqm;
    if (dto.isTypical !== undefined) data.isTypical = dto.isTypical;
    if (dto.typicalCount !== undefined) data.typicalCount = dto.typicalCount;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.zone.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.zone.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Zone deleted' };
  }

  async copyStructure(id: number, newParentId: number) {
    const source = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
      include: { children: { where: { deletedAt: null } } },
    });
    if (!source) throw new NotFoundException('Source zone not found');

    const newParent = await this.prisma.zone.findFirst({
      where: { id: newParentId, deletedAt: null },
    });
    if (!newParent) throw new NotFoundException('Target parent zone not found');

    // Wrap the recursive copy in a transaction so a partial failure does not
    // leave orphan zones behind.
    const copiedId = await this.prisma.$transaction(async (tx) => {
      const copyZone = async (
        sourceZone: any,
        parentId: number,
        parentPath: string,
        depth: number,
      ): Promise<number> => {
        const created = await tx.zone.create({
          data: {
            projectId: sourceZone.projectId,
            parentId,
            zoneType: sourceZone.zoneType || 'zone',
            name: `${sourceZone.name} (copy)`,
            code: sourceZone.code ? `${sourceZone.code}-copy` : null,
            areaSqm: sourceZone.areaSqm,
            description: sourceZone.description,
            isTypical: sourceZone.isTypical,
            typicalCount: sourceZone.typicalCount,
            path: '',
            depth,
          },
        });

        const fullPath = parentPath ? `${parentPath}/${created.id}` : `${created.id}`;
        await tx.zone.update({ where: { id: created.id }, data: { path: fullPath } });

        const children = await tx.zone.findMany({
          where: { parentId: sourceZone.id, deletedAt: null },
        });
        for (const child of children) {
          await copyZone(child, created.id, fullPath, depth + 1);
        }

        return created.id;
      };

      return copyZone(source, newParentId, newParent.path, newParent.depth + 1);
    }, { timeout: 30_000 });

    return this.findOne(copiedId);
  }

  async explodeTypical(id: number) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, deletedAt: null },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    if (!zone.isTypical || zone.typicalCount <= 1) {
      return [zone];
    }

    // Wrap explode + soft-delete in a transaction. Without this, a partial
    // failure leaves half the copies created but the original still active.
    return this.prisma.$transaction(async (tx) => {
      const createdZones: any[] = [];
      for (let i = 1; i <= zone.typicalCount; i++) {
        const created = await tx.zone.create({
          data: {
            projectId: zone.projectId,
            parentId: zone.parentId,
            zoneType: zone.zoneType || 'zone',
            name: `${zone.name} ${i}`,
            code: zone.code ? `${zone.code}-${i}` : null,
            areaSqm: zone.areaSqm,
            description: zone.description,
            isTypical: false,
            typicalCount: 1,
            path: '',
            depth: zone.depth,
          },
        });

        const parentPath = zone.path.split('/').slice(0, -1).join('/');
        const fullPath = parentPath ? `${parentPath}/${created.id}` : `${created.id}`;
        await tx.zone.update({ where: { id: created.id }, data: { path: fullPath } });
        createdZones.push({ ...created, path: fullPath });
      }

      await tx.zone.update({ where: { id }, data: { deletedAt: new Date() } });
      return createdZones;
    }, { timeout: 30_000 });
  }

  async applyTaskTemplate(zoneId: number, templateId: number, userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const zone = await tx.zone.findUniqueOrThrow({ where: { id: zoneId } });
      const template = await tx.template.findUniqueOrThrow({
        where: { id: templateId },
        include: { templateTasks: { include: { serviceType: true } } },
      });

      // Use the service template's phaseId for all tasks (falls back to per-task phaseId)
      const templatePhaseId = template.phaseId;
      const catalog = await this.loadCatalogMap(tx);

      const createdTasks: any[] = [];
      for (const tt of template.templateTasks) {
        if (tt.serviceTypeId) {
          await tx.zoneServiceType.upsert({
            where: { zoneId_serviceTypeId: { zoneId, serviceTypeId: tt.serviceTypeId } },
            create: { zoneId, serviceTypeId: tt.serviceTypeId },
            update: {},
          });
        }
        const { budgetHours, budgetAmount } = this.resolveBudget(tt, catalog);
        const task = await tx.task.create({
          data: {
            zoneId,
            projectId: zone.projectId,
            serviceTypeId: tt.serviceTypeId,
            code: tt.code,
            name: tt.name,
            description: tt.description,
            budgetHours,
            budgetAmount,
            phaseId: templatePhaseId ?? tt.phaseId,
            priority: tt.defaultPriority,
            status: 'not_started',
            createdBy: userId,
          },
        });
        createdTasks.push(task);
      }
      await tx.template.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });
      return createdTasks;
    }, { timeout: 30_000 });
  }

  async duplicateZone(zoneId: number, newName: string, userId: number) {
    const zone = await this.prisma.zone.findUniqueOrThrow({
      where: { id: zoneId },
      include: {
        tasks: { where: { deletedAt: null } },
        zoneServiceTypes: true,
        children: {
          where: { deletedAt: null },
          include: {
            tasks: { where: { deletedAt: null } },
            zoneServiceTypes: true,
            children: {
              where: { deletedAt: null },
              include: {
                tasks: { where: { deletedAt: null } },
                zoneServiceTypes: true,
              },
            },
          },
        },
      },
    });

    const existing = await this.prisma.zone.findFirst({
      where: { projectId: zone.projectId, name: newName, deletedAt: null },
    });
    if (existing) throw new ConflictException('Zone name must be unique within project');

    return this.prisma.$transaction(async (tx) => {
      const copyZoneRecursive = async (sourceZone: any, parentId: number | null, parentPath: string, depth: number, zoneName: string) => {
        const newZone = await tx.zone.create({
          data: {
            projectId: sourceZone.projectId,
            parentId,
            zoneType: sourceZone.zoneType,
            name: zoneName,
            code: sourceZone.code,
            path: '',
            depth,
            sortOrder: sourceZone.sortOrder + 1,
          },
        });
        const path = parentPath ? `${parentPath}/${newZone.id}` : `${newZone.id}`;
        await tx.zone.update({ where: { id: newZone.id }, data: { path } });

        // Copy service types
        for (const zst of (sourceZone.zoneServiceTypes || [])) {
          await tx.zoneServiceType.create({
            data: { zoneId: newZone.id, serviceTypeId: zst.serviceTypeId, sortOrder: zst.sortOrder },
          });
        }

        // Copy ALL tasks
        for (const task of (sourceZone.tasks || [])) {
          await tx.task.create({
            data: {
              zoneId: newZone.id, projectId: sourceZone.projectId,
              serviceTypeId: task.serviceTypeId, code: task.code, name: task.name,
              description: task.description, budgetHours: task.budgetHours, budgetAmount: task.budgetAmount,
              phaseId: task.phaseId, priority: task.priority, status: 'not_started', completionPct: 0, createdBy: userId,
            },
          });
        }

        // Recursively copy children
        for (const child of (sourceZone.children || [])) {
          await copyZoneRecursive(child, newZone.id, path, depth + 1, child.name);
        }

        return { ...newZone, path };
      };

      const result = await copyZoneRecursive(zone, zone.parentId, '', zone.depth, newName);
      return result;
    }, { timeout: 30_000 });
  }

  async applyProjectTemplate(projectId: number, templateId: number, userId: number, zoneName?: string) {
    const template = await this.prisma.template.findUniqueOrThrow({
      where: { id: templateId },
      include: {
        templateTasks: true,
        templateZones: {
          include: {
            templateZoneTasks: true,
            linkedTaskTemplate: {
              include: { templateTasks: true },
              // linkedTaskTemplate is a service template — its phaseId is available
            },
            children: {
              include: {
                templateZoneTasks: true,
                linkedTaskTemplate: { include: { templateTasks: true } },
                children: {
                  include: {
                    templateZoneTasks: true,
                    linkedTaskTemplate: { include: { templateTasks: true } },
                  },
                },
              },
            },
          },
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    const resolveBudget = this.resolveBudget.bind(this);

    return this.prisma.$transaction(async (tx) => {
      const catalog = await this.loadCatalogMap(tx);
      const createdZones: any[] = [];

      // ─── Composition multiplicity ──────────────────────────────────────
      // If a template-zone has instanceCount > 1, instantiate it that many
      // times. Each instance is a separate, individually-renameable zone in
      // the project, with the same children/tasks underneath. Default 1 keeps
      // legacy templates' behaviour unchanged.
      const createZoneRecursive = async (tz: any, parentId: number | null, parentPath: string, depth: number) => {
        const rawCount = Number(tz.instanceCount);
        const instanceCount = Number.isFinite(rawCount) && rawCount > 1 ? Math.floor(rawCount) : 1;
        if (instanceCount === 1) {
          await createSingleZone(tz, tz.name, parentId, parentPath, depth);
          return;
        }
        for (let i = 0; i < instanceCount; i++) {
          // Default naming: "<Template name> <N>". The user can rename each
          // instance afterwards via the inline edit in the planning view.
          const instanceName = `${tz.name} ${i + 1}`;
          await createSingleZone(tz, instanceName, parentId, parentPath, depth);
        }
      };

      const createSingleZone = async (tz: any, instanceName: string, parentId: number | null, parentPath: string, depth: number) => {
        const zone = await tx.zone.create({
          data: {
            projectId,
            parentId,
            zoneType: tz.zoneType || 'zone',
            name: instanceName,
            code: tz.code,
            isTypical: tz.isTypical || false,
            typicalCount: tz.typicalCount || 1,
            path: '',
            depth,
          },
        });

        const path = parentPath ? `${parentPath}/${zone.id}` : `${zone.id}`;
        await tx.zone.update({ where: { id: zone.id }, data: { path } });
        createdZones.push({ ...zone, path });

        // Create tasks from linked task template (service template)
        if (tz.linkedTaskTemplate?.templateTasks) {
          // Use the service template's phaseId for all its tasks
          const servicePhaseId = (tz.linkedTaskTemplate as any).phaseId;
          for (const tt of tz.linkedTaskTemplate.templateTasks) {
            const budget = resolveBudget(tt, catalog);
            await tx.task.create({
              data: {
                zoneId: zone.id, projectId, serviceTypeId: tt.serviceTypeId,
                code: tt.code, name: tt.name, description: tt.description,
                budgetHours: budget.budgetHours, budgetAmount: budget.budgetAmount,
                phaseId: servicePhaseId ?? tt.phaseId, priority: tt.defaultPriority, status: 'not_started', createdBy: userId,
              },
            });
          }
        }

        // Create tasks from templateZoneTasks (inline tasks on the zone)
        if (tz.templateZoneTasks?.length) {
          for (const tzt of tz.templateZoneTasks) {
            const budget = resolveBudget(tzt, catalog);
            await tx.task.create({
              data: {
                zoneId: zone.id, projectId, serviceTypeId: tzt.serviceTypeId,
                code: tzt.code, name: tzt.name, description: tzt.description,
                budgetHours: budget.budgetHours, budgetAmount: budget.budgetAmount,
                phaseId: tzt.phaseId, priority: tzt.defaultPriority, status: 'not_started', createdBy: userId,
              },
            });
          }
        }

        // Handle referenced template — fetch and copy its tasks + zones recursively
        if (tz.referencedTemplateId) {
          const refTemplate = await tx.template.findUnique({
            where: { id: tz.referencedTemplateId },
            include: {
              templateTasks: true,
              templateZones: {
                include: {
                  templateZoneTasks: true,
                  linkedTaskTemplate: { include: { templateTasks: true } },
                  children: {
                    include: {
                      templateZoneTasks: true,
                      linkedTaskTemplate: { include: { templateTasks: true } },
                    },
                  },
                },
                where: { parentId: null },
                orderBy: { sortOrder: 'asc' },
              },
            },
          });

          if (refTemplate) {
            // Copy root-level templateTasks using referenced template's phaseId
            const refPhaseId = refTemplate.phaseId;
            for (const tt of (refTemplate.templateTasks || [])) {
              const budget = resolveBudget(tt, catalog);
              await tx.task.create({
                data: {
                  zoneId: zone.id, projectId, serviceTypeId: tt.serviceTypeId,
                  code: tt.code, name: tt.name, description: tt.description,
                  budgetHours: budget.budgetHours, budgetAmount: budget.budgetAmount,
                  phaseId: refPhaseId ?? tt.phaseId, priority: tt.defaultPriority || 'medium', status: 'not_started', createdBy: userId,
                },
              });
            }

            // Recursively create child zones from referenced template
            for (const childTz of (refTemplate.templateZones || [])) {
              await createZoneRecursive(childTz, zone.id, path, depth + 1);
            }
          }
        }

        // Recurse into direct children
        for (const child of (tz.children || [])) {
          await createZoneRecursive(child, zone.id, path, depth + 1);
        }
      };

      // Create a main project zone with user's chosen name (or template name as fallback)
      const mainZone = await tx.zone.create({
        data: { projectId, zoneType: 'zone', name: zoneName?.trim() || template.name, code: template.code, path: '', depth: 0 },
      });
      const mainPath = `${mainZone.id}`;
      await tx.zone.update({ where: { id: mainZone.id }, data: { path: mainPath } });
      createdZones.push({ ...mainZone, path: mainPath });

      // Create tasks from root-level templateTasks on the main zone
      if (template.templateTasks?.length) {
        for (const tt of template.templateTasks) {
          const budget = resolveBudget(tt, catalog);
          await tx.task.create({
            data: {
              zoneId: mainZone.id, projectId, serviceTypeId: tt.serviceTypeId,
              code: tt.code, name: tt.name, description: tt.description,
              budgetHours: budget.budgetHours, budgetAmount: budget.budgetAmount,
              phaseId: tt.phaseId, priority: tt.defaultPriority || 'medium', status: 'not_started', createdBy: userId,
            },
          });
        }
      }

      // Create child zones from templateZones under the main zone
      for (const rootZone of template.templateZones) {
        await createZoneRecursive(rootZone, mainZone.id, mainPath, 1);
      }

      // Increment usage count
      await tx.template.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });

      return createdZones;
    }, { timeout: 30_000 });
  }

  async batchReorder(items: { id: number; sortOrder: number; parentId?: number | null }[]) {
    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.zone.update({
          where: { id: item.id },
          data: {
            sortOrder: item.sortOrder,
            ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
          },
        }),
      ),
    );
    return { message: `Reordered ${items.length} zones` };
  }
}
