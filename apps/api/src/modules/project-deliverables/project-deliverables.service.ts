import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDeliverableDto } from './dto/create-project-deliverable.dto';
import { UpdateProjectDeliverableDto } from './dto/update-project-deliverable.dto';
import { ReorderProjectDeliverablesDto } from './dto/reorder-project-deliverables.dto';

/**
 * CRUD for the first-class, per-project Deliverable entity.
 *
 * A ProjectDeliverable is instantiated from a catalog Template but OWNS its
 * own name/description/order/status — renaming it changes the project's
 * deliverable as the PM and customer see it (planning grid, execution board,
 * reports), without ever mutating the shared catalog template.
 */
@Injectable()
export class ProjectDeliverablesService {
  constructor(private prisma: PrismaService) {}

  private readonly selectShape = {
    id: true,
    projectId: true,
    sourceTemplateId: true,
    serviceId: true,
    name: true,
    description: true,
    sortOrder: true,
    status: true,
    service: { select: { id: true, name: true, color: true } },
  } as const;

  /** Resolve a deliverable → its projectId (for authorization). */
  async getProjectId(id: number): Promise<number> {
    const row = await this.prisma.projectDeliverable.findFirst({
      where: { id, deletedAt: null },
      select: { projectId: true },
    });
    if (!row) throw new NotFoundException('Deliverable not found');
    return row.projectId;
  }

  /** List a project's deliverables, ordered for display. */
  async findAllForProject(projectId: number) {
    return this.prisma.projectDeliverable.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: this.selectShape,
    });
  }

  async create(dto: CreateProjectDeliverableDto) {
    // Default sortOrder to the end of the project's current list.
    let sortOrder = dto.sortOrder;
    if (sortOrder == null) {
      const last = await this.prisma.projectDeliverable.findFirst({
        where: { projectId: dto.projectId, deletedAt: null },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    // Inherit the Service line from the source template's phase when not given.
    let serviceId = dto.serviceId ?? null;
    if (serviceId == null && dto.sourceTemplateId != null) {
      const tmpl = await this.prisma.template.findUnique({
        where: { id: dto.sourceTemplateId },
        select: { phaseId: true },
      });
      serviceId = tmpl?.phaseId ?? null;
    }

    return this.prisma.projectDeliverable.create({
      data: {
        projectId: dto.projectId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        sourceTemplateId: dto.sourceTemplateId ?? null,
        serviceId,
        sortOrder,
        status: 'active',
      },
      select: this.selectShape,
    });
  }

  async update(id: number, dto: UpdateProjectDeliverableDto) {
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.serviceId !== undefined) data.serviceId = dto.serviceId;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.projectDeliverable.update({
      where: { id },
      data,
      select: this.selectShape,
    });
  }

  /** Batch reorder within a project. */
  async reorder(dto: ReorderProjectDeliverablesDto) {
    await this.prisma.$transaction(
      dto.items.map((it) =>
        this.prisma.projectDeliverable.update({
          where: { id: it.id },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return { updated: dto.items.length };
  }

  /**
   * Soft-delete a deliverable. Tasks linked to it keep their row but lose the
   * link (project_deliverable_id is set NULL by the FK's ON DELETE SET NULL on
   * a hard delete; for the soft delete we null it explicitly so the board
   * doesn't render a phantom column).
   */
  async remove(id: number) {
    await this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { projectDeliverableId: id },
        data: { projectDeliverableId: null },
      }),
      this.prisma.projectDeliverable.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'archived' },
      }),
    ]);
    return { id, deleted: true };
  }
}
