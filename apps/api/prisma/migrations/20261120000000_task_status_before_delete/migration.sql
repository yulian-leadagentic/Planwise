-- Task restore keeps the previous status (2026-11-20) — a soft delete
-- (single task, or the cascade under a deleted zone) flips status to
-- 'cancelled'; the status the task had before is now saved here so
-- POST /tasks/:id/restore can put it back. Additive and nullable, no
-- backfill: tasks deleted before this change have NULL and restore
-- falls back to the old behaviour (cancelled → not_started). The enum
-- values match `tasks.status` (20260329053955_init).
ALTER TABLE `tasks`
  ADD COLUMN `status_before_delete` ENUM('not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled') NULL AFTER `status`;
