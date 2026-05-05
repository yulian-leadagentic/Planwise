import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async findAll(type?: string) {
    const where: any = { deletedAt: null };
    if (type) where.type = type;

    // Load templates + the per-template-zone fields we need to recursively
    // count tasks across the full composition graph (referencedTemplateId,
    // linkedTaskTemplateId, inline task counts, multiplicity).
    const templates = await this.prisma.template.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        _count: { select: { templateTasks: true, templateZones: true } },
        templateTasks: { select: { id: true, description: true }, take: 100 },
        templateZones: {
          select: {
            instanceCount: true,
            referencedTemplateId: true,
            linkedTaskTemplateId: true,
            _count: { select: { templateZoneTasks: true } },
          },
        },
      },
    });

    // Build an id → template lookup for the recursive rollup below.
    const byId = new Map<number, any>(templates.map((t: any) => [t.id, t]));

    // Effective zone count = SUM(instanceCount) across template zones (a
    // "Floor ×3" composition contributes 3, not 1).
    // Effective task count = recursive rollup: root tasks + for each zone,
    // (inline templateZoneTasks + linkedTaskTemplate's tasks + referencedTemplate's
    // total tasks) × instanceCount. memoised per template; cycle-guarded.
    const taskTotalCache = new Map<number, number>();
    const visiting = new Set<number>();

    const computeTotalTasks = (id: number): number => {
      if (taskTotalCache.has(id)) return taskTotalCache.get(id)!;
      if (visiting.has(id)) return 0; // cycle — bail out
      const t = byId.get(id);
      if (!t) return 0;
      visiting.add(id);
      let total = t._count?.templateTasks ?? 0;
      for (const z of (t.templateZones ?? [])) {
        const mult = Math.max(1, Number(z.instanceCount) || 1);
        let zoneTasks = z._count?.templateZoneTasks ?? 0;
        if (z.linkedTaskTemplateId) {
          const linked = byId.get(z.linkedTaskTemplateId);
          zoneTasks += linked?._count?.templateTasks ?? 0;
        }
        if (z.referencedTemplateId) {
          zoneTasks += computeTotalTasks(z.referencedTemplateId);
        }
        total += zoneTasks * mult;
      }
      visiting.delete(id);
      taskTotalCache.set(id, total);
      return total;
    };

    return templates.map((t: any) => {
      const expandedZones = (t.templateZones ?? []).reduce(
        (sum: number, z: any) => sum + Math.max(1, Number(z.instanceCount) || 1),
        0,
      );
      const effectiveTasks = computeTotalTasks(t.id);
      return {
        ...t,
        _count: {
          ...t._count,
          templateZones: expandedZones,
          templateZoneRows: t._count?.templateZones ?? 0,
          // Direct-only count preserved for any caller that needs it.
          templateRootTasks: t._count?.templateTasks ?? 0,
          // Override `templateTasks` with the rolled-up effective count so
          // existing UI ("X tasks" labels) shows the realistic total.
          templateTasks: effectiveTasks,
        },
        templateZones: undefined,
      };
    });
  }

  async create(userId: number, body: any) {
    const template = await this.prisma.template.create({
      data: {
        code: body.code || `TPL-${Date.now()}`,
        name: body.name,
        type: body.type || 'task_list',
        category: body.category || null,
        description: body.description || null,
        phaseId: body.phaseId || null,
        createdBy: userId,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });

    // If tasks are provided inline, create them
    if (body.tasks && Array.isArray(body.tasks)) {
      for (let i = 0; i < body.tasks.length; i++) {
        const t = body.tasks[i];
        await this.prisma.templateTask.create({
          data: {
            templateId: template.id,
            serviceTypeId: t.serviceTypeId || null,
            code: t.code,
            name: t.name,
            description: t.description || null,
            defaultBudgetHours: t.defaultBudgetHours || null,
            defaultBudgetAmount: t.defaultBudgetAmount || null,
            defaultPriority: t.defaultPriority || 'medium',
            phaseId: t.phaseId || null,
            sortOrder: t.sortOrder ?? i,
          },
        });
      }
    }

    return this.findOne(template.id);
  }

  async findOne(id: number) {
    const template = await this.prisma.template.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
        templateTasks: {
          include: { serviceType: true, phase: true },
          orderBy: { sortOrder: 'asc' },
        },
        templateZones: {
          include: {
            children: {
              include: {
                linkedTaskTemplate: { select: { id: true, name: true, code: true } },
                referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                templateZoneTasks: { include: { serviceType: true, phase: true } },
                children: {
                  include: {
                    linkedTaskTemplate: { select: { id: true, name: true, code: true } },
                    referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
                    templateZoneTasks: { include: { serviceType: true, phase: true } },
                  },
                },
              },
            },
            linkedTaskTemplate: { select: { id: true, name: true, code: true } },
            referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
            templateZoneTasks: { include: { serviceType: true, phase: true } },
          },
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async update(id: number, body: any) {
    await this.findOne(id);
    return this.prisma.template.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code,
        category: body.category,
        description: body.description,
        isActive: body.isActive,
        phaseId: body.phaseId !== undefined ? (body.phaseId || null) : undefined,
      },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        phase: true,
      },
    });
  }

  async remove(id: number) {
    const template = await this.findOne(id);
    if (template.usageCount > 0) {
      throw new BadRequestException(`Cannot delete: template has been used ${template.usageCount} times`);
    }
    await this.prisma.template.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { message: 'Template deleted' };
  }

  async addTask(templateId: number, body: any) {
    await this.findOne(templateId);
    const maxOrder = await this.prisma.templateTask.aggregate({
      where: { templateId },
      _max: { sortOrder: true },
    });
    return this.prisma.templateTask.create({
      data: {
        templateId,
        serviceTypeId: body.serviceTypeId || null,
        code: body.code,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        defaultPriority: body.defaultPriority || 'medium',
        phaseId: body.phaseId || null,
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { serviceType: true, phase: true },
    });
  }

  async updateTask(taskId: number, body: any) {
    return this.prisma.templateTask.update({
      where: { id: taskId },
      data: {
        serviceTypeId: body.serviceTypeId,
        code: body.code,
        name: body.name,
        description: body.description,
        defaultBudgetHours: body.defaultBudgetHours,
        defaultBudgetAmount: body.defaultBudgetAmount,
        defaultPriority: body.defaultPriority,
        phaseId: body.phaseId,
        sortOrder: body.sortOrder,
      },
      include: { serviceType: true, phase: true },
    });
  }

  async removeTask(taskId: number) {
    await this.prisma.templateTask.delete({ where: { id: taskId } });
    return { message: 'Template task removed' };
  }

  async addZone(templateId: number, body: any) {
    await this.findOne(templateId); // verify template exists
    const maxOrder = await this.prisma.templateZone.aggregate({
      where: { templateId, parentId: body.parentId || null },
      _max: { sortOrder: true },
    });
    return this.prisma.templateZone.create({
      data: {
        templateId,
        parentId: body.parentId || null,
        zoneType: body.zoneType || 'zone',
        name: body.name,
        code: body.code || null,
        isTypical: body.isTypical || false,
        typicalCount: body.typicalCount || 1,
        // Composition multiplicity — clamp to >=1 so a malformed body can't
        // mean "0 instances" (which would silently drop the zone at apply).
        instanceCount: Math.max(1, Number(body.instanceCount) || 1),
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
        linkedTaskTemplateId: body.linkedTaskTemplateId || null,
        referencedTemplateId: body.referencedTemplateId || null,
      },
      include: {
        linkedTaskTemplate: { select: { id: true, name: true, code: true } },
        referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
      },
    });
  }

  async updateZone(zoneId: number, body: any) {
    // Only set instanceCount if the caller explicitly sent it; otherwise
    // leave whatever's in the DB. Clamp to >=1 to avoid 0 / negative values.
    const instanceCount = body.instanceCount === undefined
      ? undefined
      : Math.max(1, Number(body.instanceCount) || 1);
    return this.prisma.templateZone.update({
      where: { id: zoneId },
      data: {
        name: body.name,
        code: body.code,
        zoneType: body.zoneType,
        isTypical: body.isTypical,
        typicalCount: body.typicalCount,
        instanceCount,
        sortOrder: body.sortOrder,
        linkedTaskTemplateId: body.linkedTaskTemplateId,
        referencedTemplateId: body.referencedTemplateId,
      },
      include: {
        linkedTaskTemplate: { select: { id: true, name: true, code: true } },
        referencedTemplate: { select: { id: true, name: true, code: true, type: true } },
      },
    });
  }

  async removeZone(zoneId: number) {
    // Cascade will delete children and templateZoneTasks
    await this.prisma.templateZone.delete({ where: { id: zoneId } });
    return { message: 'Template zone deleted' };
  }

  async addZoneTask(templateZoneId: number, body: any) {
    const maxOrder = await this.prisma.templateZoneTask.aggregate({
      where: { templateZoneId },
      _max: { sortOrder: true },
    });
    return this.prisma.templateZoneTask.create({
      data: {
        templateZoneId,
        code: body.code,
        name: body.name,
        description: body.description || null,
        defaultBudgetHours: body.defaultBudgetHours || null,
        defaultBudgetAmount: body.defaultBudgetAmount || null,
        phaseId: body.phaseId || null,
        serviceTypeId: body.serviceTypeId || null,
        defaultPriority: body.defaultPriority || 'medium',
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
      include: { phase: true },
    });
  }

  async removeZoneTask(id: number) {
    await this.prisma.templateZoneTask.delete({ where: { id } });
    return { message: 'Zone task deleted' };
  }

  async duplicate(id: number, userId: number, body: { name: string; code: string }) {
    const source = await this.findOne(id);

    const newTemplate = await this.prisma.template.create({
      data: {
        code: body.code,
        name: body.name,
        type: source.type,
        category: source.category,
        description: source.description,
        phaseId: source.phaseId,
        createdBy: userId,
      },
    });

    for (const task of source.templateTasks) {
      await this.prisma.templateTask.create({
        data: {
          templateId: newTemplate.id,
          serviceTypeId: task.serviceTypeId,
          code: task.code,
          name: task.name,
          description: task.description,
          defaultBudgetHours: task.defaultBudgetHours,
          defaultBudgetAmount: task.defaultBudgetAmount,
          defaultPriority: task.defaultPriority,
          phaseId: task.phaseId,
          sortOrder: task.sortOrder,
        },
      });
    }

    return this.findOne(newTemplate.id);
  }
}
