import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@Injectable()
export class ZonesService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId: number) {
    return this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      include: { zoneType: true },
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async findTree(projectId: number) {
    const zones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      include: { zoneType: true },
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
        zoneType: true,
        children: { where: { deletedAt: null }, include: { zoneType: true } },
        zoneAssignments: { include: { deliverable: true } },
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
        zoneTypeId: dto.zoneTypeId,
        name: dto.name,
        code: dto.code,
        areaSqm: dto.areaSqm,
        description: dto.description,
        color: dto.color,
        isTypical: dto.isTypical ?? false,
        typicalCount: dto.typicalCount ?? 1,
        path: '', // placeholder, updated below
        depth,
      },
      include: { zoneType: true },
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

    return this.prisma.zone.update({
      where: { id },
      data: {
        ...dto,
        areaSqm: dto.areaSqm !== undefined ? dto.areaSqm : undefined,
      },
      include: { zoneType: true },
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
          zoneTypeId: sourceZone.zoneTypeId,
          name: `${sourceZone.name} (copy)`,
          code: sourceZone.code ? `${sourceZone.code}-copy` : null,
          areaSqm: sourceZone.areaSqm,
          description: sourceZone.description,
          color: sourceZone.color,
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

    const createdZones = [];

    for (let i = 1; i <= zone.typicalCount; i++) {
      const created = await this.prisma.zone.create({
        data: {
          projectId: zone.projectId,
          parentId: zone.parentId,
          zoneTypeId: zone.zoneTypeId,
          name: `${zone.name} ${i}`,
          code: zone.code ? `${zone.code}-${i}` : null,
          areaSqm: zone.areaSqm,
          description: zone.description,
          color: zone.color,
          isTypical: false,
          typicalCount: 1,
          path: '',
          depth: zone.depth,
        },
        include: { zoneType: true },
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
}
