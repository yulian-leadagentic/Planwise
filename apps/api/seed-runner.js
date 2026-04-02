const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
  try {
    // Service Types
    const serviceTypes = [
      { name: 'BIM Coordination', code: 'BIM', color: '#3B82F6', sortOrder: 1 },
      { name: 'MEP', code: 'MEP', color: '#10B981', sortOrder: 2 },
      { name: 'Structural', code: 'STR', color: '#EF4444', sortOrder: 3 },
      { name: 'Architecture', code: 'ARCH', color: '#8B5CF6', sortOrder: 4 },
      { name: 'Infrastructure', code: 'INFRA', color: '#F59E0B', sortOrder: 5 },
      { name: 'Fire Protection', code: 'FIRE', color: '#DC2626', sortOrder: 6 },
      { name: 'Acoustics', code: 'ACO', color: '#06B6D4', sortOrder: 7 },
    ];
    for (const st of serviceTypes) {
      await prisma.serviceType.upsert({ where: { name: st.name }, update: st, create: st });
    }
    console.log('  Seeded service types');

    // Phases
    const phases = [
      { name: 'Pre-Design', sortOrder: 1 },
      { name: 'Design', sortOrder: 2 },
      { name: 'Construction', sortOrder: 3 },
      { name: 'AFC', sortOrder: 4 },
      { name: 'Handover', sortOrder: 5 },
      { name: 'Maintenance', sortOrder: 6 },
    ];
    for (const p of phases) {
      await prisma.phase.upsert({ where: { name: p.name }, update: p, create: p });
    }
    console.log('  Seeded phases');

    // Project Types
    const projectTypes = [
      'BIM Coordination', 'BIM Management', 'MEP Coordination',
      'Infrastructure', 'Buildings', 'Roads', 'Software', 'Mixed',
    ];
    for (const name of projectTypes) {
      await prisma.projectType.upsert({ where: { name }, update: { name }, create: { name } });
    }
    console.log('  Seeded project types');

    // Modules
    const modules = [
      { name: 'Dashboard', route: '/', icon: 'LayoutDashboard', sortOrder: 1 },
      { name: 'Tasks', route: '/tasks', icon: 'CheckSquare', sortOrder: 2 },
      { name: 'Time', route: '/time', icon: 'Clock', sortOrder: 3 },
      { name: 'Projects', route: '/projects', icon: 'FolderKanban', sortOrder: 4 },
      { name: 'Contracts', route: '/contracts', icon: 'FileText', sortOrder: 5 },
      { name: 'People', route: '/people', icon: 'Users', sortOrder: 6 },
      { name: 'Reports', route: '/reports', icon: 'BarChart3', sortOrder: 7 },
      { name: 'Templates', route: '/templates', icon: 'Copy', sortOrder: 8 },
      { name: 'Admin', route: '/admin', icon: 'Settings', sortOrder: 9 },
    ];
    for (const m of modules) {
      const existing = await prisma.module.findFirst({ where: { name: m.name } });
      if (!existing) await prisma.module.create({ data: m });
    }
    console.log('  Seeded modules');

    // Admin role + permissions
    let adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
    if (!adminRole) {
      adminRole = await prisma.role.create({ data: { name: 'Admin', description: 'Full system access' } });
      const allModules = await prisma.module.findMany();
      for (const mod of allModules) {
        await prisma.roleModule.create({
          data: { roleId: adminRole.id, moduleId: mod.id, canRead: true, canWrite: true, canDelete: true },
        });
      }
      console.log('  Created Admin role with permissions');
    }

    // Admin user
    const adminExists = await prisma.user.findUnique({ where: { email: 'admin@amec.com' } });
    if (!adminExists) {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('Admin@123', 10);
      await prisma.user.create({
        data: {
          email: 'admin@amec.com',
          password: hash,
          firstName: 'System',
          lastName: 'Admin',
          roleId: adminRole.id,
          userType: 'employee',
          isActive: true,
        },
      });
      console.log('  Created admin user (admin@amec.com / Admin@123)');
    }

    console.log('Seed complete!');
  } catch (e) {
    console.error('Seed error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
