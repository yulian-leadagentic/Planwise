import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@Injectable()
export class ZonesService {
  constructor(private prisma: PrismaService) {}

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

    if (!source) {
      throw new NotFoundException('Source zone not found');
    }

    const newParent = await this.prisma.zone.findFirst({
      where: { id: newParentId, deletedAt: null },
    });

    if (!newParent) {
      throw new NotFoundException('Target parent zone not found');
    }

    // Deep copy recursively
    const copyZone = async (
      sourceZone: any,
      parentId: number,
      parentPath: string,
      depth: number,
    ) => {
      const created = await this.prisma.zone.create({
        data: {
          projectId: sourceZone.projectId,
          parentId,
          zoneType: sourceZone.zoneType || "zone",
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

      const fullPath = parentPath
        ? `${parentPath}/${created.id}`
        : `${created.id}`;
      await this.prisma.zone.update({
        where: { id: created.id },
        data: { path: fullPath },
      });

      // Recursively copy children
      const children = await this.prisma.zone.findMany({
        where: { parentId: sourceZone.id, deletedAt: null },
      });

      for (const child of children) {
        await copyZone(child, created.id, fullPath, depth + 1);
      }

      return created;
    };

    const copied = await copyZone(
      source,
      newParentId,
      newParent.path,
      newParent.depth + 1,
    );

    return this.findOne(copied.id);
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

    const createdZones: any[] = [];

    for (let i = 1; i <= zone.typicalCount; i++) {
      const created = await this.prisma.zone.create({
        data: {
          projectId: zone.projectId,
          parentId: zone.parentId,
          zoneType: zone.zoneType || "zone",
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
      const fullPath = parentPath
        ? `${parentPath}/${created.id}`
        : `${created.id}`;

      await this.prisma.zone.update({
        where: { id: created.id },
        data: { path: fullPath },
      });

      createdZones.push({ ...created, path: fullPath });
    }

    // Soft delete the original typical zone
    await this.prisma.zone.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return createdZones;
  }

  async applyTaskTemplate(zoneId: number, templateId: number, userId: number) {
    const zone = await this.prisma.zone.findUniqueOrThrow({ where: { id: zoneId } });
    const template = await this.prisma.template.findUniqueOrThrow({
      where: { id: templateId },
      include: { templateTasks: { include: { serviceType: true } } },
    });

    return this.prisma.$transaction(async (tx) => {
      const createdTasks: any[] = [];
      for (const tt of template.templateTasks) {
        if (tt.serviceTypeId) {
          await tx.zoneServiceType.upsert({
            where: { zoneId_serviceTypeId: { zoneId, serviceTypeId: tt.serviceTypeId } },
            create: { zoneId, serviceTypeId: tt.serviceTypeId },
            update: {},
          });
        }
        const task = await tx.task.create({
          data: {
            zoneId,
            projectId: zone.projectId,
            serviceTypeId: tt.serviceTypeId,
            code: tt.code,
            name: tt.name,
            description: tt.description,
            budgetHours: tt.defaultBudgetHours,
            budgetAmount: tt.defaultBudgetAmount,
            phaseId: tt.phaseId,
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
    });
  }

  async duplicateZone(zoneId: number, newName: string, userId: number) {
    const zone = await this.prisma.zone.findUniqueOrThrow({
      where: { id: zoneId },
      include: {
        tasks: { where: { deletedAt: null } },
        zoneServiceTypes: true,
      },
    });

    const existing = await this.prisma.zone.findFirst({
      where: { projectId: zone.projectId, name: newName, deletedAt: null },
    });
    if (existing) throw new ConflictException('Zone name must be unique within project');

    return this.prisma.$transaction(async (tx) => {
      const newZone = await tx.zone.create({
        data: {
          projectId: zone.projectId,
          parentId: zone.parentId,
          zoneType: zone.zoneType,
          name: newName,
          path: '',
          depth: zone.depth,
          sortOrder: zone.sortOrder + 1,
        },
      });
      const parent = zone.parentId ? await tx.zone.findUnique({ where: { id: zone.parentId } }) : null;
      const path = parent ? `${parent.path}/${newZone.id}` : `/${newZone.id}`;
      await tx.zone.update({ where: { id: newZone.id }, data: { path } });

      for (const zst of zone.zoneServiceTypes) {
        await tx.zoneServiceType.create({
          data: { zoneId: newZone.id, serviceTypeId: zst.serviceTypeId, sortOrder: zst.sortOrder },
        });
      }
      for (const task of zone.tasks) {
        await tx.task.create({
          data: {
            zoneId: newZone.id,
            projectId: zone.projectId,
            serviceTypeId: task.serviceTypeId,
            code: task.code,
            name: task.name,
            description: task.description,
            budgetHours: task.budgetHours,
            budgetAmount: task.budgetAmount,
            phaseId: task.phaseId,
            priority: task.priority,
            status: 'not_started',
            completionPct: 0,
            createdBy: userId,
          },
        });
      }
      return { ...newZone, path };
    });
  }

  async applyProjectTemplate(projectId: number, templateId: number, userId: number) {
    const template = await this.prisma.template.findUniqueOrThrow({
      where: { id: templateId },
      include: {
        templateZones: {
          include: {
            templateZoneTasks: true,
            linkedTaskTemplate: {
              include: { templateTasks: true },
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

    return this.prisma.$transaction(async (tx) => {
      const createdZones: any[] = [];

      const createZoneRecursive = async (tz: any, parentId: number | null, parentPath: string, depth: number) => {
        const zone = await tx.zone.create({
          data: {
            projectId,
            parentId,
            zoneType: tz.zoneType || 'zone',
            name: tz.name,
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

        // Create tasks from linked task template
        if (tz.linkedTaskTemplate?.templateTasks) {
          for (const tt of tz.linkedTaskTemplate.templateTasks) {
            await tx.task.create({
              data: {
                zoneId: zone.id,
                projectId,
                serviceTypeId: tt.serviceTypeId,
                code: tt.code,
                name: tt.name,
                description: tt.description,
                budgetHours: tt.defaultBudgetHours,
                budgetAmount: tt.defaultBudgetAmount,
                phaseId: tt.phaseId,
                priority: tt.defaultPriority,
                status: 'not_started',
                createdBy: userId,
              },
            });
          }
        }

        // Create tasks from templateZoneTasks (for combined templates)
        if (tz.templateZoneTasks?.length) {
          for (const tzt of tz.templateZoneTasks) {
            await tx.task.create({
              data: {
                zoneId: zone.id,
                projectId,
                serviceTypeId: tzt.serviceTypeId,
                code: tzt.code,
                name: tzt.name,
                description: tzt.description,
                budgetHours: tzt.defaultBudgetHours,
                budgetAmount: tzt.defaultBudgetAmount,
                phaseId: tzt.phaseId,
                priority: tzt.defaultPriority,
                status: 'not_started',
                createdBy: userId,
              },
            });
          }
        }

        // Recurse into children
        for (const child of (tz.children || [])) {
          await createZoneRecursive(child, zone.id, path, depth + 1);
        }
      };

      for (const rootZone of template.templateZones) {
        await createZoneRecursive(rootZone, null, '', 0);
      }

      // Increment usage count
      await tx.template.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });

      return createdZones;
    });
  }
}
