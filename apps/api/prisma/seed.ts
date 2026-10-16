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

  // HR module (Phase A2, 2026-10-15) — new top-level module. Upserts on
  // `route` (unique) so re-running is a no-op and avoids clashing with
  // the id = sortOrder convention above (ids 1-9 are already taken by
  // the baseline modules). The default role-module permissions loop
  // below picks this up via `modules.push(hrMod)`; the HR-specific role
  // grants (HR Manager / HR Clerk) land further down in this seeder.
  const hrMod = await prisma.module.upsert({
    where: { route: '/hr' },
    update: { name: 'HR', icon: 'ClipboardList', sortOrder: 10 },
    create: { name: 'HR', route: '/hr', icon: 'ClipboardList', sortOrder: 10 },
  });
  modules.push(hrMod);

  // Sub-modules (must be created AFTER top-level modules to reference parentId)
  const projectsMod = modules.find((m: any) => m.name === 'Projects');
  const tasksMod = modules.find((m: any) => m.name === 'Tasks');
  const timeMod = modules.find((m: any) => m.name === 'Time');
  const templatesMod = modules.find((m: any) => m.name === 'Templates');
  const adminMod = modules.find((m: any) => m.name === 'Admin');
  // Dashboard is a top-level module but no sub-modules currently hang
  // off it. Operations used to be registered here but was retired in
  // feat/ops-complete (see block below). Leaving this line as a
  // reference for future dashboard sub-modules.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const dashboardMod = modules.find((m: any) => m.name === 'Dashboard');

  const subModuleData = [
    { name: 'Project Planning', route: 'project-planning', icon: 'Layers', sortOrder: 41, parentId: projectsMod?.id },
    { name: 'Task Approval', route: 'task-approval', icon: 'CheckCircle', sortOrder: 21, parentId: tasksMod?.id },
    { name: 'Task Reassignment', route: 'task-reassignment', icon: 'UserPlus', sortOrder: 22, parentId: tasksMod?.id },
    // Fine-grained gate (added 2026-06-17). Lets an admin grant
    // "can change due dates" without giving full Tasks write.
    // usePermissions.can('tasks/edit-due-date', 'write') checks this.
    { name: 'Task: Edit Due Date', route: 'tasks/edit-due-date', icon: 'Calendar', sortOrder: 23, parentId: tasksMod?.id },
    { name: 'Time Approval', route: 'time-approval', icon: 'Clock', sortOrder: 31, parentId: timeMod?.id },
    { name: 'Task Templates', route: 'task-templates', icon: 'BookOpen', sortOrder: 81, parentId: templatesMod?.id },
    { name: 'Zone Templates', route: 'zone-templates', icon: 'Map', sortOrder: 82, parentId: templatesMod?.id },
    { name: 'Personal Data', route: 'personal-data', icon: 'User', sortOrder: 91, parentId: adminMod?.id },
    { name: 'Calendar', route: 'calendar', icon: 'Calendar', sortOrder: 92, parentId: adminMod?.id },
    { name: 'Roles', route: 'roles', icon: 'Shield', sortOrder: 93, parentId: adminMod?.id },
    // Org-tree admin — introduced in feat/org-tree-admin. Guarded by
    // `org:manage` (read+write on this module). Admin only by default;
    // any other role that gets it can create / rename / move / delete
    // org units and set unit managers / user home units.
    { name: 'Organization', route: 'org', icon: 'Sitemap', sortOrder: 94, parentId: adminMod?.id },
    // Note: the Operations dashboard is intentionally NOT registered as
    // a grantable module. Its endpoints are gated on `projects:read`
    // and the view itself is a read-only aggregation over projects the
    // caller already has access to — so exposing it in the permissions
    // matrix would only invite drift ("I unchecked Operations but the
    // person still sees it"). The '/operations' front-end route falls
    // back to the projects:read check. (feat/ops-complete, 2026-08.)
  ];
  // Idempotent sub-module upsert keyed on `route` (unique). Fixes the
  // long-standing "Operations doesn't appear in Add Module" bug — the
  // old find-by-name pattern was best-effort and never re-ran once a
  // seed created a partial set, so any sub-module added later never
  // made it onto older environments. Using upsert here means every
  // startup guarantees the full catalog. (T-fix Tier A #9a, 2026-06-30.)
  for (const sm of subModuleData) {
    if (!sm.parentId) continue;
    const sub = await prisma.module.upsert({
      where: { route: sm.route },
      update: {
        name: sm.name,
        icon: sm.icon,
        sortOrder: sm.sortOrder,
        parentId: sm.parentId,
      },
      create: sm,
    });
    modules.push(sub);
  }
  console.log(`  Seeded ${subModuleData.length} sub-modules`);

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
  //
  // Admin-only defaults: 'Organization' (the org-tree admin surface)
  // is gated by `org:manage` and is admin-only in the seed. 'HR' is
  // added here (Phase A2, 2026-10-15) so the default Manager/Employee
  // rows DON'T get canRead on HR — HR Manager + HR Clerk are the two
  // seeded roles that may see employee personal/medical data, and the
  // guard's NO_ADMIN_BYPASS blocks admins from inheriting read via the
  // role-name shortcut. Admins still get a full-permission row below;
  // they just need to hold it explicitly. Other modules follow the
  // standard four-role default matrix.
  const ADMIN_ONLY_MODULES = new Set(['Organization', 'HR']);
  for (const mod of modules) {
    const isAdminOnly = ADMIN_ONLY_MODULES.has(mod.name);
    const perms = [
      { roleId: adminRole.id, moduleId: mod.id, canRead: true, canWrite: true, canDelete: true, canApprove: true, canExport: true },
      { roleId: managerRole.id, moduleId: mod.id, canRead: !isAdminOnly, canWrite: !isAdminOnly && mod.name !== 'Admin', canDelete: false, canApprove: !isAdminOnly && ['Time', 'Tasks', 'Time Approval', 'Task Approval'].includes(mod.name), canExport: !isAdminOnly && ['Reports'].includes(mod.name) },
      { roleId: employeeRole.id, moduleId: mod.id, canRead: !isAdminOnly && mod.name !== 'Admin', canWrite: !isAdminOnly && ['Tasks', 'Time'].includes(mod.name), canDelete: false, canApprove: false, canExport: false },
      { roleId: partnerRole.id, moduleId: mod.id, canRead: !isAdminOnly && ['Dashboard', 'Tasks', 'Time', 'Projects'].includes(mod.name), canWrite: !isAdminOnly && ['Tasks', 'Time'].includes(mod.name), canDelete: false, canApprove: false, canExport: false },
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

  // Phases (v8 — replaces ServicePhase).
  // Added 2026-06-18: three Hebrew sub-phases used by the BM migration
  // Excel ("תכנון מפורט / סופי / לביצוע"). They live alongside the
  // English design/construction set so existing data isn't touched;
  // sortOrder 21-23 keeps them visually grouped after the legacy list.
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
    await prisma.phase.upsert({
      where: { name: p.name },
      update: p,
      create: p,
    });
  }
  console.log(`  Seeded ${phases.length} phases`);

  // Project Types
  // BM2 QA-2 Commit 5 (PR-021): removed BIM Coordination / BIM Management /
  // MEP Coordination from the ProjectType seed — those are *service* types
  // (they belong on service/deliverable), not project *categories*. The
  // matching entries in `serviceTypes` above already cover them. Existing
  // databases: the accompanying migration deletes those three rows when no
  // project still references them; leftover references stay for admin to
  // reassign via the Admin → Project Types UI.
  const projectTypes = [
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

  // ───────────────────────────────────────────────────────────────────
  // HR Phase A2 (2026-10-15) — HR module catalog + role seeding.
  // Idempotent (upsert-only); the admin runs `prisma db seed` on Railway
  // after the Phase-A1 migration applies.
  // ───────────────────────────────────────────────────────────────────

  // HrSettings — singleton row (id=1). update:{} means re-running the
  // seed NEVER overwrites admin-set values.
  await prisma.hrSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 }, // schema defaults (5/5/5) kick in
  });
  console.log('  Seeded hr_settings singleton');

  // SpecialHourBucket — 9 Yulian-approved rows per §3.6 of the spec. All
  // seeded with isSystem=true + defaultCreditMode=REPORTED. Phase B/C
  // flips individual rows to AUTO as the behavior ships.
  type BucketSeed = {
    code: string;
    nameHe: string;
    behavior: 'A' | 'B' | 'C';
    unit: 'DAY' | 'HOUR';
    requiresDocument: boolean;
    dailyAmount: number | null;
    maxPerYear: number | null;
    minDailyStandard: number | null;
    sortOrder: number;
  };
  const bucketSeeds: BucketSeed[] = [
    { code: 'nursing_parenting',       nameHe: 'הנקה / הורות',               behavior: 'B', unit: 'HOUR', requiresDocument: true,  dailyAmount: 1,    maxPerYear: null, minDailyStandard: 8, sortOrder: 10 },
    { code: 'reservist_spouse_bucket', nameHe: 'נשות מילואים (זכאות B)',     behavior: 'B', unit: 'HOUR', requiresDocument: true,  dailyAmount: 1,    maxPerYear: null, minDailyStandard: 8, sortOrder: 20 },
    { code: 'pregnancy',               nameHe: 'הריון',                       behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 40,   minDailyStandard: null, sortOrder: 30 },
    { code: 'fertility',               nameHe: 'פוריות',                      behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 40,   minDailyStandard: null, sortOrder: 40 },
    { code: 'special_child_care',      nameHe: 'טיפול בילד',                  behavior: 'C', unit: 'HOUR', requiresDocument: true,  dailyAmount: null, maxPerYear: 52,   minDailyStandard: null, sortOrder: 50 },
    { code: 'training',                nameHe: 'השתלמות',                     behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, sortOrder: 60 },
    { code: 'cross_project',           nameHe: 'רוחב',                        behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, sortOrder: 70 },
    { code: 'meetings',                nameHe: 'ישיבות',                      behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, sortOrder: 80 },
    { code: 'culture',                 nameHe: 'תרבות',                       behavior: 'A', unit: 'HOUR', requiresDocument: false, dailyAmount: null, maxPerYear: null, minDailyStandard: null, sortOrder: 90 },
  ];
  for (const b of bucketSeeds) {
    await prisma.specialHourBucket.upsert({
      where: { code: b.code },
      // Keep schema-controlled catalog values authoritative on re-run,
      // but DON'T re-flip defaultCreditMode or active — an HR admin
      // may have changed those by hand after the first seed.
      update: {
        nameHe: b.nameHe,
        behavior: b.behavior,
        unit: b.unit,
        requiresDocument: b.requiresDocument,
        dailyAmount: b.dailyAmount ?? null,
        maxPerYear: b.maxPerYear ?? null,
        minDailyStandard: b.minDailyStandard ?? null,
        sortOrder: b.sortOrder,
        isSystem: true,
      },
      create: {
        code: b.code,
        nameHe: b.nameHe,
        behavior: b.behavior,
        unit: b.unit,
        requiresDocument: b.requiresDocument,
        dailyAmount: b.dailyAmount ?? null,
        maxPerYear: b.maxPerYear ?? null,
        minDailyStandard: b.minDailyStandard ?? null,
        defaultCreditMode: 'REPORTED',
        sortOrder: b.sortOrder,
        isSystem: true,
        active: true,
      },
    });
  }
  console.log(`  Seeded ${bucketSeeds.length} special_hour_buckets`);

  // HR Manager + HR Clerk roles — upsert-by-name so a seed re-run is a
  // no-op. Keep the existing row's description when present to avoid
  // overwriting a hand-edited admin label.
  let hrManagerRole = await prisma.role.findFirst({ where: { name: 'HR Manager' } });
  if (!hrManagerRole) {
    hrManagerRole = await prisma.role.create({
      data: { name: 'HR Manager', description: 'HR admin — manage employees, buckets, approvals (HR Phase A)' },
    });
  }
  let hrClerkRole = await prisma.role.findFirst({ where: { name: 'HR Clerk' } });
  if (!hrClerkRole) {
    hrClerkRole = await prisma.role.create({
      data: { name: 'HR Clerk', description: 'HR read-only — browse + export HR data (HR Phase A)' },
    });
  }

  // Role-module grants for the two HR roles. Keyed on (roleId, moduleId)
  // so re-running is idempotent (findFirst-then-upsert matches the
  // pattern used by the default role-module loop above).
  // NB: a `timeMod` variable is already declared earlier in this seeder
  // (sub-module parent lookup). Reusing that name here would shadow it
  // and TSC blocks a redeclaration — pick a fresh name.
  const hrTimeMod = modules.find((m: any) => m.name === 'Time');
  const hrModule = modules.find((m: any) => m.name === 'HR');
  if (!hrModule) {
    // Defensive: the HR module was pushed into `modules` above. If this
    // ever fires something upstream broke; log loudly rather than silently
    // skip the role grants and leave HR Manager/Clerk without access.
    throw new Error('HR module missing from `modules` array during seed');
  }

  // Grants per spec §1.4:
  //   HR Manager × hr    : read + write + approve + export (no delete)
  //   HR Manager × time  : read only (so they can approve timesheets)
  //   HR Clerk   × hr    : read + export
  const hrGrants: Array<{
    roleId: number;
    moduleId: number;
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
    canApprove: boolean;
    canExport: boolean;
  }> = [
    { roleId: hrManagerRole.id, moduleId: hrModule.id, canRead: true, canWrite: true, canDelete: false, canApprove: true,  canExport: true },
    ...(hrTimeMod
      ? [{ roleId: hrManagerRole.id, moduleId: hrTimeMod.id, canRead: true, canWrite: false, canDelete: false, canApprove: false, canExport: false }]
      : []),
    { roleId: hrClerkRole.id, moduleId: hrModule.id, canRead: true, canWrite: false, canDelete: false, canApprove: false, canExport: true },
  ];
  for (const g of hrGrants) {
    const existing = await prisma.roleModule.findFirst({
      where: { roleId: g.roleId, moduleId: g.moduleId },
    });
    if (existing) {
      await prisma.roleModule.update({
        where: { id: existing.id },
        data: {
          canRead: g.canRead,
          canWrite: g.canWrite,
          canDelete: g.canDelete,
          canApprove: g.canApprove,
          canExport: g.canExport,
        },
      });
    } else {
      await prisma.roleModule.create({ data: g });
    }
  }
  console.log('  Seeded HR Manager + HR Clerk role grants');

  // ───────────────────────────────────────────────────────────────────
  // HR Phase B2 (2026-10-15) — AbsenceType catalog. 9 Yulian-approved
  // rows per spec §3.4. Idempotent: upsert on `code` with update:{} so
  // re-running the seed never clobbers a hand-edited admin label
  // (nameHe / maxPerYear / sortOrder stay authoritative to whatever
  // the HR UI last saved; initial values below are the create-only
  // defaults). "לידה / maternity" is deliberately absent per §3.4.
  // ───────────────────────────────────────────────────────────────────
  const absenceTypes: Array<{
    code: string;
    nameHe: string;
    unit: 'DAY' | 'HOUR';
    requiresDocument: boolean;
    deductsFromSick: boolean;
    maxPerYear: number | null;
    halfDay: boolean;
    sortOrder: number;
    isSystem: boolean;
  }> = [
    { code: 'holiday_full',           nameHe: 'חג',                                 unit: 'DAY',  requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder:  1, isSystem: true },
    { code: 'holiday_eve_leave',      nameHe: 'חופש בערב חג',                        unit: 'DAY',  requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: true,  sortOrder: 10, isSystem: true },
    { code: 'chol_hamoed_leave',      nameHe: 'חופש בחוה"מ',                         unit: 'DAY',  requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: true,  sortOrder: 20, isSystem: true },
    { code: 'vacation',               nameHe: 'חופשה',                               unit: 'DAY',  requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 30, isSystem: true },
    { code: 'sick',                   nameHe: 'מחלה',                                unit: 'DAY',  requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 40, isSystem: true },
    { code: 'reserve_duty',           nameHe: 'מילואים',                             unit: 'DAY',  requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 50, isSystem: true },
    { code: 'special_child_care_day', nameHe: 'טיפול בילד צרכים מיוחדים',           unit: 'DAY',  requiresDocument: true,  deductsFromSick: true,  maxPerYear: 18,   halfDay: false, sortOrder: 60, isSystem: true },
    { code: 'reservist_spouse',       nameHe: 'נשות מילואים',                        unit: 'DAY',  requiresDocument: true,  deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 70, isSystem: true },
    { code: 'bereavement_1st_degree', nameHe: 'פטירת קרוב דרגה ראשונה',             unit: 'DAY',  requiresDocument: false, deductsFromSick: false, maxPerYear: null, halfDay: false, sortOrder: 80, isSystem: true },
  ];
  for (const t of absenceTypes) {
    await prisma.absenceType.upsert({
      where: { code: t.code },
      update: {},
      create: t,
    });
  }
  console.log(`  Seeded ${absenceTypes.length} absence_types`);

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
