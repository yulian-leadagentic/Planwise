-- Rollback for 20260508100000_task_deliverable_template_id.
--
-- Prisma's `migrate` command does not run *.down.sql files automatically;
-- this file is here as the canonical rollback recipe to run by hand
-- against a target environment if we ever need to revert.
--
--   docker exec -i planwise-mysql-1 mysql -u<user> -p<pass> <db> \
--     < apps/api/prisma/migrations/20260508100000_task_deliverable_template_id/migration.down.sql
--   docker exec -it planwise-api-1 sh -c "cd apps/api && \
--     npx prisma migrate resolve --rolled-back 20260508100000_task_deliverable_template_id"
--
-- The DROP COLUMN is safe: the column was added nullable in the up
-- migration so any data written into it is purely a best-effort
-- denormalised pointer back to templates(id). The grouping logic still
-- has serviceType.name and phase.name fallbacks so the planning grid
-- keeps rendering after this rolls back.

ALTER TABLE `tasks` DROP FOREIGN KEY `tasks_deliverable_template_id_fkey`;
DROP INDEX `tasks_deliverable_template_id_idx` ON `tasks`;
ALTER TABLE `tasks` DROP COLUMN `deliverable_template_id`;
