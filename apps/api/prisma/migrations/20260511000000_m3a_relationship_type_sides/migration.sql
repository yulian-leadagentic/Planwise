-- M3a — Add named-side fields to partner_relationship_types so the form
-- and lists can read "Customer of → Project Alpha" instead of the muddy
-- "source → target". Legacy applicable_* columns stay until M3b.

ALTER TABLE `partner_relationship_types`
  ADD COLUMN `side_a_label`    VARCHAR(100) NULL,
  ADD COLUMN `side_b_label`    VARCHAR(100) NULL,
  ADD COLUMN `side_a_kind`     VARCHAR(20)  NULL,
  ADD COLUMN `side_b_kind`     VARCHAR(20)  NULL,
  ADD COLUMN `inverse_label`   VARCHAR(100) NULL,
  ADD COLUMN `is_symmetric`    BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN `allows_multiple` BOOLEAN      NOT NULL DEFAULT TRUE;

-- Backfill the 4 system types. sideAKind/sideBKind = the entity kinds allowed
-- on each side; 'project' marks rows that M3b moves to ProjectPartnerRole.
UPDATE `partner_relationship_types`
  SET side_a_label = 'Employee',
      side_b_label = 'Employer',
      side_a_kind  = 'person',
      side_b_kind  = 'organization',
      inverse_label = 'Employs',
      allows_multiple = TRUE
  WHERE code = 'worker_of';

UPDATE `partner_relationship_types`
  SET side_a_label = 'Customer',
      side_b_label = 'Project',
      side_a_kind  = 'organization',
      side_b_kind  = 'project',
      inverse_label = 'Customer',
      allows_multiple = FALSE
  WHERE code = 'customer_of_project';

UPDATE `partner_relationship_types`
  SET side_a_label = 'Supplier',
      side_b_label = 'Project',
      side_a_kind  = 'organization',
      side_b_kind  = 'project',
      inverse_label = 'Supplier',
      allows_multiple = TRUE
  WHERE code = 'supplier_of_project';

UPDATE `partner_relationship_types`
  SET side_a_label = 'Participant',
      side_b_label = 'Project',
      side_a_kind  = 'person',
      side_b_kind  = 'project',
      inverse_label = 'Participant',
      allows_multiple = TRUE
  WHERE code = 'participates_in_project';
