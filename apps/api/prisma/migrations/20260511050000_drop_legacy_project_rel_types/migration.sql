-- Remove the three legacy project-targeted PartnerRelationshipType rows.
-- Their data already lives in project_partner_roles (migrated in M3b),
-- and writes were redirected to project_partner_roles in M3d. They're
-- now pure cruft and the user wants a clean catalog before going to
-- production.
--
-- Step 1: delete any business_partner_relationships rows that reference
--         these types (FK).
-- Step 2: delete the catalog rows themselves.
-- The 'project' value on the RelationshipTarget enum stays — it's a
-- schema enum and removing it requires a more invasive migration.
-- Nothing writes 'project' anymore.

DELETE FROM `business_partner_relationships`
  WHERE `relationship_type_id` IN (
    SELECT `id` FROM `partner_relationship_types`
    WHERE `code` IN ('customer_of_project', 'supplier_of_project', 'participates_in_project')
  );

DELETE FROM `partner_relationship_types`
  WHERE `code` IN ('customer_of_project', 'supplier_of_project', 'participates_in_project');
