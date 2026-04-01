import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';

@Injectable()
export class LabelsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateLabelDto) {
    let path = dto.name;
    let depth = 0;

    if (dto.parentId) {
      const parent = await this.prisma.label.findFirst({ where: { id: dto.parentId } });
      if (!parent) {
        throw new NotFoundException('Parent label not found');
      }
      path = `${parent.path} / ${dto.name}`;
      depth = parent.depth + 1;
    }

    return this.prisma.label.create({
      data: {
        projectId: dto.projectId,
        parentId: dto.parentId,
        labelTypeId: dto.labelTypeId,
        name: dto.name,
        path,
        depth,
        sortOrder: dto.sortOrder ?? 0,
        description: dto.description,
        color: dto.color,
      },
      include: { parent: true },
    });
  }

  async findByProject(projectId: number) {
    return this.prisma.label.findMany({
      where: { projectId },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async getTree(projectId: number) {
    const labels = await this.prisma.label.findMany({
      where: { projectId },
      include: {
        _count: { select: { children: true } },
      },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    });

    return this.buildTree(labels);
  }

  private buildTree(labels: any[], parentId: number | null = null): any[] {
    return labels
      .filter((label) => label.parentId === parentId)
      .map((label) => ({
        ...label,
        children: this.buildTree(labels, label.id),
      }));
  }

  async findOne(id: number) {
    const label = await this.prisma.label.findFirst({
      where: { id },
      include: {
        parent: true,
        children: {
          orderBy: { sortOrder: 'asc' },
        },
        milestones: true,
      },
    });

    if (!label) {
      throw new NotFoundException('Label not found');
    }

    return label;
  }

  async update(id: number, dto: UpdateLabelDto) {
    const existing = await this.findOne(id);

    const data: any = { ...dto };

    // Recompute path if name changed
    if (dto.name && dto.name !== existing.name) {
      if (existing.parentId) {
        const parent = await this.prisma.label.findFirst({ where: { id: existing.parentId } });
        data.path = parent ? `${parent.path} / ${dto.name}` : dto.name;
      } else {
        data.path = dto.name;
      }

      // Update all descendants paths
      await this.updateDescendantPaths(id, existing.path, data.path);
    }

    return this.prisma.label.update({
      where: { id },
      data,
      include: { parent: true },
    });
  }

  private async updateDescendantPaths(parentId: number, oldPath: string, newPath: string) {
    const descendants = await this.prisma.label.findMany({
      where: { path: { startsWith: oldPath + ' / ' } },
    });

    for (const descendant of descendants) {
      await this.prisma.label.update({
        where: { id: descendant.id },
        data: { path: descendant.path.replace(oldPath, newPath) },
      });
    }
  }

  async reorder(id: number, parentId: number | null, sortOrder: number) {
    const label = await this.findOne(id);

    let path = label.name;
    let depth = 0;

    if (parentId) {
      const parent = await this.prisma.label.findFirst({ where: { id: parentId } });
      if (!parent) {
        throw new NotFoundException('Target parent label not found');
      }
      path = `${parent.path} / ${label.name}`;
      depth = parent.depth + 1;
    }

    const oldPath = label.path;

    const updated = await this.prisma.label.update({
      where: { id },
      data: { parentId, sortOrder, path, depth },
    });

    // Update descendants if path changed
    if (oldPath !== path) {
      await this.updateDescendantPaths(id, oldPath, path);
    }

    return updated;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.label.delete({ where: { id } });
    return { message: 'Label deleted' };
  }
}
