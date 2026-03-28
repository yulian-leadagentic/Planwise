import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Modules
  const modules = await Promise.all([
    prisma.module.create({
      data: { name: 'Dashboard', route: '/', icon: 'LayoutDashboard', sortOrder: 1 },
    }),
    prisma.module.create({
      data: { name: 'Tasks', route: '/tasks', icon: 'CheckSquare', sortOrder: 2 },
    }),
    prisma.module.create({
      data: { name: 'Time', route: '/time', icon: 'Clock', sortOrder: 3 },
    }),
    prisma.module.create({
      data: { name: 'Projects', route: '/projects', icon: 'FolderKanban', sortOrder: 4 },
    }),
    prisma.module.create({
      data: { name: 'Contracts', route: '/contracts', icon: 'FileText', sortOrder: 5 },
    }),
    prisma.module.create({
      data: { name: 'People', route: '/people', icon: 'Users', sortOrder: 6 },
    }),
    prisma.module.create({
      data: { name: 'Reports', route: '/reports', icon: 'BarChart3', sortOrder: 7 },
    }),
    prisma.module.create({
      data: { name: 'Templates', route: '/templates', icon: 'Copy', sortOrder: 8 },
    }),
    prisma.module.create({
      data: { name: 'Admin', route: '/admin', icon: 'Settings', sortOrder: 9 },
    }),
  ]);

  // Roles
  const adminRole = await prisma.role.create({
    data: { name: 'Admin', description: 'Full system access' },
  });
  const managerRole = await prisma.role.create({
    data: { name: 'Manager', description: 'Project and team management' },
  });
  const employeeRole = await prisma.role.create({
    data: { name: 'Employee', description: 'Standard employee access' },
  });
  const partnerRole = await prisma.role.create({
    data: { name: 'Partner', description: 'External partner access' },
  });

  // Admin gets full access to all modules
  for (const mod of modules) {
    await prisma.roleModule.create({
      data: {
        roleId: adminRole.id,
        moduleId: mod.id,
        canRead: true,
        canWrite: true,
        canDelete: true,
      },
    });
  }

  // Manager gets read/write on most, no admin delete
  for (const mod of modules) {
    const isAdmin = mod.name === 'Admin';
    await prisma.roleModule.create({
      data: {
        roleId: managerRole.id,
        moduleId: mod.id,
        canRead: true,
        canWrite: !isAdmin,
        canDelete: false,
      },
    });
  }

  // Employee gets read on most, write on tasks/time
  for (const mod of modules) {
    const canWrite = ['Tasks', 'Time'].includes(mod.name);
    const canRead = !['Admin'].includes(mod.name);
    await prisma.roleModule.create({
      data: {
        roleId: employeeRole.id,
        moduleId: mod.id,
        canRead,
        canWrite,
        canDelete: false,
      },
    });
  }

  // Partner gets limited access
  for (const mod of modules) {
    const canRead = ['Dashboard', 'Tasks', 'Time', 'Projects'].includes(mod.name);
    const canWrite = ['Tasks', 'Time'].includes(mod.name);
    await prisma.roleModule.create({
      data: {
        roleId: partnerRole.id,
        moduleId: mod.id,
        canRead,
        canWrite,
        canDelete: false,
      },
    });
  }

  // Label Types
  await prisma.labelType.createMany({
    data: [
      { name: 'Phase', color: '#3B82F6', icon: 'Layers', sortOrder: 1 },
      { name: 'Category', color: '#10B981', icon: 'FolderTree', sortOrder: 2 },
      { name: 'Discipline', color: '#8B5CF6', icon: 'BookOpen', sortOrder: 3 },
      { name: 'Zone', color: '#F59E0B', icon: 'MapPin', sortOrder: 4 },
      { name: 'System', color: '#EF4444', icon: 'Cpu', sortOrder: 5 },
    ],
  });

  // Project Types
  await prisma.projectType.createMany({
    data: [
      { name: 'Civil Engineering' },
      { name: 'Structural Engineering' },
      { name: 'Electrical Engineering' },
      { name: 'Mechanical Engineering' },
      { name: 'Architecture' },
      { name: 'Infrastructure' },
      { name: 'Renovation' },
    ],
  });

  // Admin User
  const hashedPassword = await bcrypt.hash('Admin@123', 10);
  await prisma.user.create({
    data: {
      email: 'admin@amec.com',
      password: hashedPassword,
      firstName: 'System',
      lastName: 'Admin',
      roleId: adminRole.id,
      userType: 'employee',
      position: 'System Administrator',
      department: 'IT',
      isActive: true,
    },
  });

  console.log('Seed completed successfully!');
  console.log('Admin login: admin@amec.com / Admin@123');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
