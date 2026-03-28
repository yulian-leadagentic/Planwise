import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Resetting database...');

  // Delete in reverse dependency order
  const tables = [
    'email_logs',
    'notifications',
    'activity_logs',
    'team_template_members',
    'team_templates',
    'template_tasks',
    'template_labels',
    'project_templates',
    'time_entries',
    'time_clock',
    'work_schedules',
    'calendar_days',
    'billings',
    'contract_items',
    'contracts',
    'expenses',
    'terms',
    'contacts',
    'label_milestones',
    'task_plan_times',
    'task_comments',
    'task_assignees',
    'tasks',
    'labels',
    'project_members',
    'projects',
    'role_modules',
    'modules',
    'users',
    'roles',
    'label_types',
    'project_types',
  ];

  for (const table of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);
    console.log(`  Cleared: ${table}`);
  }

  console.log('Database reset complete.');
}

main()
  .catch((e) => {
    console.error('Reset failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
