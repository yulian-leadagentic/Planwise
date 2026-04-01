import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Modules
  const moduleData = [
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
  const modules: any[] = [];
  for (const m of moduleData) {
    const mod = await prisma.module.upsert({
      where: { id: m.sortOrder },
      update: m,
      create: m,
    });
    modules.push(mod);
  }

  // Roles
  let adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
  if (!adminRole) {
    adminRole = await prisma.role.create({ data: { name: 'Admin', description: 'Full system access' } });
  }
  let managerRole = await prisma.role.findFirst({ where: { name: 'Manager' } });
  if (!managerRole) {
    managerRole = await prisma.role.create({ data: { name: 'Manager', description: 'Project and team management' } });
  }
  let employeeRole = await prisma.role.findFirst({ where: { name: 'Employee' } });
  if (!employeeRole) {
    employeeRole = await prisma.role.create({ data: { name: 'Employee', description: 'Standard employee access' } });
  }
  let partnerRole = await prisma.role.findFirst({ where: { name: 'Partner' } });
  if (!partnerRole) {
    partnerRole = await prisma.role.create({ data: { name: 'Partner', description: 'External partner access' } });
  }

  // Role-module permissions (upsert to avoid duplicates)
  for (const mod of modules) {
    const perms = [
      { roleId: adminRole.id, moduleId: mod.id, canRead: true, canWrite: true, canDelete: true },
      { roleId: managerRole.id, moduleId: mod.id, canRead: true, canWrite: mod.name !== 'Admin', canDelete: false },
      { roleId: employeeRole.id, moduleId: mod.id, canRead: mod.name !== 'Admin', canWrite: ['Tasks', 'Time'].includes(mod.name), canDelete: false },
      { roleId: partnerRole.id, moduleId: mod.id, canRead: ['Dashboard', 'Tasks', 'Time', 'Projects'].includes(mod.name), canWrite: ['Tasks', 'Time'].includes(mod.name), canDelete: false },
    ];
    for (const p of perms) {
      const existing = await prisma.roleModule.findFirst({
        where: { roleId: p.roleId, moduleId: p.moduleId },
      });
      if (!existing) {
        await prisma.roleModule.create({ data: p });
      }
    }
  }

  // Service Types (v8 — replaces ServiceCategory)
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
    await prisma.serviceType.upsert({
      where: { name: st.name },
      update: st,
      create: st,
    });
  }
  console.log(`  Seeded ${serviceTypes.length} service types`);

  // Phases (v8 — replaces ServicePhase)
  const phases = [
    { name: 'Pre-Design', sortOrder: 1 },
    { name: 'Design', sortOrder: 2 },
    { name: 'Construction', sortOrder: 3 },
    { name: 'AFC', sortOrder: 4 },
    { name: 'Handover', sortOrder: 5 },
    { name: 'Maintenance', sortOrder: 6 },
  ];
  for (const p of phases) {
    await prisma.phase.upsert({
      where: { name: p.name },
      update: p,
      create: p,
    });
  }
  console.log(`  Seeded ${phases.length} phases`);

  // Project Types
  const projectTypes = [
    { name: 'BIM Coordination' },
    { name: 'BIM Management' },
    { name: 'MEP Coordination' },
    { name: 'Infrastructure' },
    { name: 'Buildings' },
    { name: 'Roads' },
    { name: 'Software' },
    { name: 'Mixed' },
  ];
  for (const pt of projectTypes) {
    await prisma.projectType.upsert({
      where: { name: pt.name },
      update: pt,
      create: pt,
    });
  }
  console.log(`  Seeded ${projectTypes.length} project types`);

  // Admin User
  const adminExists = await prisma.user.findUnique({ where: { email: 'admin@amec.com' } });
  if (!adminExists) {
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
    console.log('  Created default admin user (admin@amec.com / Admin@123)');
  }

  console.log('Seed completed!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
