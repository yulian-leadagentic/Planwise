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

    // Phases. The three Hebrew rows (sortOrder 21-23) are sub-phases
    // used by the BM migration Excel; they live alongside the legacy
    // English list so existing data isn't touched. Keep in sync with
    // prisma/seed.ts.
    const phases = [
      { name: 'Pre-Design', sortOrder: 1 },
      { name: 'Design', sortOrder: 2 },
      { name: 'Construction', sortOrder: 3 },
      { name: 'AFC', sortOrder: 4 },
      { name: 'Handover', sortOrder: 5 },
      { name: 'Maintenance', sortOrder: 6 },
      { name: 'תכנון מפורט', sortOrder: 21 },
      { name: 'תכנון סופי', sortOrder: 22 },
      { name: 'תכנון לביצוע', sortOrder: 23 },
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
      { name: 'HR', route: '/hr', icon: 'ClipboardList', sortOrder: 10 },
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

    // ──────────────────────────────────────────────────────────────────
    // HR Module + §14 RBAC seed. seed-runner.js is what Railway actually
    // executes on SEED=true; prisma/seed.ts is NOT compiled. Everything
    // below mirrors (idempotently) the HR / §14 blocks that live there.
    // ──────────────────────────────────────────────────────────────────

    // HR settings singleton. `update: {}` so a re-run never overwrites
    // admin-set 5/5/5 values; schema defaults handle first-run creation.
    await prisma.hrSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    console.log('  Seeded HR settings');

    // Special-hour bucket catalog (§3.6, 9 rows).
    const specialHourBuckets = [
      { code: 'nursing_parenting',       nameHe: 'הנקה / הורות',           behavior: 'B', unit: 'HOUR', requiresDocument: true,  dailyAmount: 1,    maxPerYear: null, minDailyStandard: 8,    defaultCreditMode: 'REPORTED', sortOrder: 10, isSystem: true },
      { code: 'reservist_spouse_bucket', nameHe: 'נשות מילואים (זכאות B)', behavior: 'B', unit: 'HOUR', requiresDocument: true,  dailyAmount: 1,    maxPerYear: null, minDailyStandard: 8,    defaultCreditMode: 'REPORTED', sortOrder: 20, isSystem: true },
      { code: 'pregnancy',               nameHe: 'הריון',                   behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 40,   minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 30, isSystem: true },
      { code: 'fertility',               nameHe: 'פוריות',                  behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 40,   minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 40, isSystem: true },
      { code: 'special_child_care',      nameHe: 'טיפול בילד',              behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 52,   minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 50, isSystem: true },
      { code: 'training',                nameHe: 'השתלמות',                 behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 60, isSystem: true },
      { code: 'cross_project',           nameHe: 'רוחב',                    behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 70, isSystem: true },
      { code: 'meetings',                nameHe: 'ישיבות',                  behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 80, isSystem: true },
      { code: 'culture',                 nameHe: 'תרבות',                   behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, defaultCreditMode: 'REPORTED', sortOrder: 90, isSystem: true },
    ];
    for (const b of specialHourBuckets) {
      await prisma.specialHourBucket.upsert({ where: { code: b.code }, update: b, create: b });
    }
    console.log('  Seeded special hour buckets');

    // Absence-type catalog (§3.4, 9 rows).
    const absenceTypes = [
      { code: 'holiday_full',           nameHe: 'חג',                              unit: 'DAY', requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder:  1, isSystem: true },
      { code: 'holiday_eve_leave',      nameHe: 'חופש בערב חג',                     unit: 'DAY', requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: true,  sortOrder: 10, isSystem: true },
      { code: 'chol_hamoed_leave',      nameHe: 'חופש בחוה"מ',                      unit: 'DAY', requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: true,  sortOrder: 20, isSystem: true },
      { code: 'vacation',               nameHe: 'חופשה',                            unit: 'DAY', requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 30, isSystem: true },
      { code: 'sick',                   nameHe: 'מחלה',                             unit: 'DAY', requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 40, isSystem: true },
      { code: 'reserve_duty',           nameHe: 'מילואים',                          unit: 'DAY', requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 50, isSystem: true },
      { code: 'special_child_care_day', nameHe: 'טיפול בילד צרכים מיוחדים',        unit: 'DAY', requiresDocument: true,  deductsFromSick: true,  maxPerYear: 18,   halfDay: false, sortOrder: 60, isSystem: true },
      { code: 'reservist_spouse',       nameHe: 'נשות מילואים',                     unit: 'DAY', requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 70, isSystem: true },
      { code: 'bereavement_1st_degree', nameHe: 'פטירת קרוב דרגה ראשונה',          unit: 'DAY', requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 80, isSystem: true },
    ];
    for (const t of absenceTypes) {
      await prisma.absenceType.upsert({ where: { code: t.code }, update: t, create: t });
    }
    console.log('  Seeded absence types');

    // §14.1 default system roles (7). Role.name has NO @unique on the
    // Prisma schema, so we use findFirst + create/update instead of
    // upsert. Each run re-asserts the module grid (wipe + recreate
    // role_modules) per Yulian's §14.1 locked spec. Legacy roles
    // (isSystem=false) are untouched — only names matching below are
    // promoted to isSystem=true. If a module ("Finance", "Data Import",
    // "HR") is missing the grant is skipped with a warning.
    const SYSTEM_ROLES = [
      { name: 'Admin', description: 'Full system access (excluding gated modules HR + Finance)',
        grants: {
          Dashboard: { R: true },
          Tasks:     { R: true, W: true, D: true, A: true, E: true },
          Time:      { R: true, W: true, D: true, A: true, E: true },
          Projects:  { R: true, W: true, D: true, A: true, E: true },
          Contracts: { R: true, W: true, D: true, A: true, E: true },
          People:    { R: true, W: true, D: true, A: true, E: true },
          Reports:   { R: true, E: true },
          Templates: { R: true, W: true, D: true, A: true, E: true },
          Admin:     { R: true, W: true, D: true, A: true, E: true },
          'Data Import': { R: true, W: true },
        } },
      { name: 'HR Manager', description: 'Full HR access + Time read',
        grants: { Dashboard: { R: true }, Time: { R: true }, HR: { R: true, W: true, A: true, E: true } } },
      { name: 'HR Clerk', description: 'HR read + export',
        grants: { Dashboard: { R: true }, Time: { R: true }, HR: { R: true, E: true } } },
      { name: 'Finance', description: 'Finance read + reports',
        grants: { Dashboard: { R: true }, Projects: { R: true }, Contracts: { R: true }, Reports: { R: true, E: true }, Finance: { R: true } } },
      { name: 'Project Manager', description: 'Project + task management',
        grants: {
          Dashboard: { R: true },
          Tasks:     { R: true, W: true, A: true },
          Time:      { R: true, A: true },
          Projects:  { R: true, W: true, D: true },
          Contracts: { R: true, W: true },
          People:    { R: true },
          Reports:   { R: true, E: true },
          Templates: { R: true },
        } },
      { name: 'Employee', description: 'Self-service time/tasks',
        grants: {
          Dashboard: { R: true },
          Tasks:     { R: true, W: true },
          Time:      { R: true, W: true },
          Projects:  { R: true },
        } },
      { name: 'Viewer', description: 'Read-only',
        grants: {
          Dashboard: { R: true }, Tasks: { R: true }, Time: { R: true }, Projects: { R: true },
          Contracts: { R: true }, People: { R: true }, Reports: { R: true },
        } },
    ];

    for (const def of SYSTEM_ROLES) {
      let role = await prisma.role.findFirst({ where: { name: def.name } });
      if (role) {
        role = await prisma.role.update({
          where: { id: role.id },
          data: { description: def.description, isSystem: true },
        });
      } else {
        role = await prisma.role.create({
          data: { name: def.name, description: def.description, isSystem: true },
        });
      }
      // Re-assert the §14.1 grid: wipe existing role_modules, recreate.
      await prisma.roleModule.deleteMany({ where: { roleId: role.id } });
      for (const [moduleName, flags] of Object.entries(def.grants)) {
        const mod = await prisma.module.findFirst({ where: { name: moduleName } });
        if (!mod) { console.warn('  [rbac] module not found: ' + moduleName); continue; }
        await prisma.roleModule.create({
          data: {
            roleId: role.id, moduleId: mod.id,
            canRead:    flags.R || false,
            canWrite:   flags.W || false,
            canDelete:  flags.D || false,
            canApprove: flags.A || false,
            canExport:  flags.E || false,
          },
        });
      }
    }
    console.log('  Seeded 7 default system roles + role_modules');

    console.log('Seed complete!');
  } catch (e) {
    console.error('Seed error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
