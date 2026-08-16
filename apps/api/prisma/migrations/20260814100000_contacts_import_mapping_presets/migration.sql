-- Migration: contacts_import_mapping_presets
--
-- BM2 · Contacts import wizard · Stage 3 (§5 of the methodology).
--
-- One row per named column-mapping preset. Seeded with ~13 templates
-- covering the top shape signatures measured in the client's real
-- 246-file folder — those alone make most files 0-click, and any
-- new shape a user encounters costs a single "Save as preset" click
-- so the second and third file of the same vendor is 0-click too.
--
-- Written by hand — same shadow-DB constraint as the earlier BM2
-- migrations. Both the CREATE TABLE and the INSERT seeds are idempotent
-- (IF NOT EXISTS / NOT EXISTS) so re-running is safe.

-- ─── 1. Table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `import_mapping_presets` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(200) NOT NULL,
  `kind`        VARCHAR(50)  NOT NULL,
  `description` VARCHAR(500) NULL,
  `mapping`     JSON NOT NULL,
  `signature`   JSON NOT NULL,
  `is_system`   BOOLEAN NOT NULL DEFAULT FALSE,
  `created_by`  INT NULL,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_import_mapping_presets_kind_name` (`kind`, `name`),
  INDEX `idx_import_mapping_presets_kind`       (`kind`),
  INDEX `idx_import_mapping_presets_created_by` (`created_by`),
  CONSTRAINT `fk_import_mapping_presets_creator`
    FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ─── 2. Seed system presets ───────────────────────────────────────────
-- Header text values come from the §4 dictionary. When the user's sheet
-- headers normalize to any value in these presets, the wizard offers
-- the preset as a one-click apply. Users can also save their own.
--
-- Each seed uses `INSERT ... SELECT ... WHERE NOT EXISTS` so re-running
-- the migration does not duplicate seeds and does not lose user edits
-- (system rows are still edit-safe from the admin's perspective; the UI
-- surfaces isSystem as a "cannot delete" hint only).

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — company · contact · email · phone · role',
       'contacts',
       'Common 5-column layout (company, contact, email, phone, role) with Hebrew headers.',
       JSON_OBJECT(
         'company', 'חברה',
         'contact', 'שם',
         'email',   'מייל',
         'phone',   'טלפון',
         'role',    'תפקיד'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','email','phone','role')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — company · contact · email · phone · role'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — company · contact · discipline · email · mobile · phone',
       'contacts',
       'Top real shape from §5 — Hebrew headers, discipline column included.',
       JSON_OBJECT(
         'company',    'חברה',
         'contact',    'שם',
         'discipline', 'תחום',
         'email',      'מייל',
         'mobile',     'נייד',
         'phone',      'טלפון'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','discipline','email','mobile','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — company · contact · discipline · email · mobile · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — address · company · contact · discipline · mobile · phone',
       'contacts',
       'Top real shape from §5 — Hebrew headers, address included, no email column.',
       JSON_OBJECT(
         'address',    'כתובת',
         'company',    'חברה',
         'contact',    'שם',
         'discipline', 'תחום',
         'mobile',     'נייד',
         'phone',      'טלפון'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('address','company','contact','discipline','mobile','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — address · company · contact · discipline · mobile · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — address · company · contact · discipline · email · mobile · phone',
       'contacts',
       'Top real shape from §5 — Hebrew headers, everything: address + email + mobile + phone.',
       JSON_OBJECT(
         'address',    'כתובת',
         'company',    'חברה',
         'contact',    'שם',
         'discipline', 'תחום',
         'email',      'מייל',
         'mobile',     'נייד',
         'phone',      'טלפון'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('address','company','contact','discipline','email','mobile','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — address · company · contact · discipline · email · mobile · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — address · company · discipline · email · phone',
       'contacts',
       'Top real shape from §5 — Hebrew headers, org-only (no contact-person column).',
       JSON_OBJECT(
         'address',    'כתובת',
         'company',    'חברה',
         'discipline', 'תחום',
         'email',      'מייל',
         'phone',      'טלפון'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('address','company','discipline','email','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — address · company · discipline · email · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Contact-only HE — contact · email · mobile · phone',
       'contacts',
       'Top real shape from §5 — Hebrew headers, no company column (freelancers list).',
       JSON_OBJECT(
         'contact', 'שם',
         'email',   'מייל',
         'mobile',  'נייד',
         'phone',   'טלפון'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('contact','email','mobile','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Contact-only HE — contact · email · mobile · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Google Contacts export',
       'contacts',
       'Google Contacts CSV export — recognized by the "E-mail 1 - Value" column.',
       JSON_OBJECT(
         'contact', 'Name',
         'email',   'E-mail 1 - Value',
         'phone',   'Phone 1 - Value'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('contact','email','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Google Contacts export'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard EN — company · contact · email · phone',
       'contacts',
       'Common 4-column English layout — company, contact, email, phone.',
       JSON_OBJECT(
         'company', 'Company',
         'contact', 'Name',
         'email',   'Email',
         'phone',   'Phone'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','email','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard EN — company · contact · email · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard EN — company · contact · email · mobile · phone · role',
       'contacts',
       '6-column English layout — company, contact, email, mobile, phone, role.',
       JSON_OBJECT(
         'company', 'Company',
         'contact', 'Name',
         'email',   'Email',
         'mobile',  'Mobile',
         'phone',   'Phone',
         'role',    'Role'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','email','mobile','phone','role')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard EN — company · contact · email · mobile · phone · role'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard EN — company · contact · discipline · email · phone',
       'contacts',
       '5-column English layout with discipline column.',
       JSON_OBJECT(
         'company',    'Company',
         'contact',    'Name',
         'discipline', 'Discipline',
         'email',      'Email',
         'phone',      'Phone'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','discipline','email','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard EN — company · contact · discipline · email · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Bare-email list — email-only',
       'contacts',
       'Headerless email list — the wizard detects this via body scan (headerless verdict).',
       JSON_OBJECT('email', 'email'),
       JSON_OBJECT('fields', JSON_ARRAY('email')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Bare-email list — email-only'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard HE — address · company · contact · email · mobile · phone · role',
       'contacts',
       'Rich Hebrew layout — everything except discipline.',
       JSON_OBJECT(
         'address', 'כתובת',
         'company', 'חברה',
         'contact', 'שם',
         'email',   'מייל',
         'mobile',  'נייד',
         'phone',   'טלפון',
         'role',    'תפקיד'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('address','company','contact','email','mobile','phone','role')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard HE — address · company · contact · email · mobile · phone · role'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Standard EN — address · company · contact · discipline · mobile · phone',
       'contacts',
       'English variant of the address+discipline+no-email shape.',
       JSON_OBJECT(
         'address',    'Address',
         'company',    'Company',
         'contact',    'Name',
         'discipline', 'Discipline',
         'mobile',     'Mobile',
         'phone',      'Phone'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('address','company','contact','discipline','mobile','phone')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Standard EN — address · company · contact · discipline · mobile · phone'
);

INSERT INTO `import_mapping_presets` (`name`, `kind`, `description`, `mapping`, `signature`, `is_system`)
SELECT 'Mixed — company · contact · email + notes',
       'contacts',
       'Compact layout with a free-text notes column commonly seen in Excel exports.',
       JSON_OBJECT(
         'company', 'Company',
         'contact', 'Name',
         'email',   'Email',
         'note',    'Notes'
       ),
       JSON_OBJECT('fields', JSON_ARRAY('company','contact','email','note')),
       TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM `import_mapping_presets` WHERE `kind` = 'contacts'
    AND `name` = 'Mixed — company · contact · email + notes'
);
