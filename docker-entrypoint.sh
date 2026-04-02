#!/bin/sh
set -e

echo "Running database migration..."
npx prisma db push --accept-data-loss --skip-generate 2>&1 || echo "Warning: prisma db push failed, continuing..."

echo "Running seed..."
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function seed() {
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
  const projectTypes = [
    'BIM Coordination','BIM Management','MEP Coordination','Infrastructure','Buildings','Roads','Software','Mixed'
  ];
  for (const name of projectTypes) {
    await prisma.projectType.upsert({ where: { name }, update: { name }, create: { name } });
  }
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
  // Admin role + user
  let adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
  if (!adminRole) {
    adminRole = await prisma.role.create({ data: { name: 'Admin', description: 'Full system access' } });
    const allModules = await prisma.module.findMany();
    for (const mod of allModules) {
      await prisma.roleModule.create({ data: { roleId: adminRole.id, moduleId: mod.id, canRead: true, canWrite: true, canDelete: true } });
    }
  }
  const adminExists = await prisma.user.findUnique({ where: { email: 'admin@amec.com' } });
  if (!adminExists) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('Admin@123', 10);
    await prisma.user.create({ data: { email: 'admin@amec.com', password: hash, firstName: 'System', lastName: 'Admin', roleId: adminRole.id, userType: 'employee', isActive: true } });
  }
  console.log('Seed complete');
}
seed().catch(e => console.error('Seed error:', e)).finally(() => prisma.\$disconnect());
" 2>&1 || echo "Warning: seed failed, continuing..."

echo "Starting application..."
exec node dist/main.js
