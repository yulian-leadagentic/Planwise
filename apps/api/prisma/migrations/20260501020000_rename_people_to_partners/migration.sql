-- Rename the top-level "People" module to "Partners" and re-point its
-- route to /partners. The new page combines orgs / contacts / employees
-- under one tabbed view; the old standalone people page is retired.
--
-- Existing role_modules grants on the People module keep working
-- automatically because we update the row in place (id is preserved,
-- only name + route + icon change).

UPDATE `modules`
SET `name`      = 'Partners',
    `route`     = '/partners',
    `icon`      = 'Briefcase',
    `updated_at` = NOW(3)
WHERE `route` = '/people' AND `parent_id` IS NULL;
