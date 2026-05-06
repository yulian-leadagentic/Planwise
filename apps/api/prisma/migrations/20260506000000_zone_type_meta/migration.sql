-- Editable presentation metadata for the ZoneType enum.
-- The enum stays the source of truth; this table only stores customisable
-- label/color/icon/sortOrder. Admin UI exposes edit-only (no add/delete)
-- so the table is always 1:1 with the enum's values.

CREATE TABLE `zone_type_meta` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(32)  NOT NULL,
  `label`      VARCHAR(64)  NOT NULL,
  `color`      VARCHAR(7)   NOT NULL,
  `icon`       VARCHAR(32)  NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `zone_type_meta_code_key` (`code`)
);

-- Seed one row per enum value with sensible defaults. Colors picked from
-- the existing palette; sort_order matches the zone-tree hierarchy.
INSERT INTO `zone_type_meta` (`code`, `label`, `color`, `icon`, `sort_order`, `updated_at`) VALUES
  ('site',     'Site',     '#0EA5E9', 'MapPin',    10, CURRENT_TIMESTAMP(3)),
  ('building', 'Building', '#3B82F6', 'Building2', 20, CURRENT_TIMESTAMP(3)),
  ('level',    'Level',    '#8B5CF6', 'Layers',    30, CURRENT_TIMESTAMP(3)),
  ('floor',    'Floor',    '#A855F7', 'Layers',    40, CURRENT_TIMESTAMP(3)),
  ('wing',     'Wing',     '#EC4899', 'Square',    50, CURRENT_TIMESTAMP(3)),
  ('section',  'Section',  '#F97316', 'Square',    60, CURRENT_TIMESTAMP(3)),
  ('area',     'Area',     '#22C55E', 'Square',    70, CURRENT_TIMESTAMP(3)),
  ('zone',     'Zone',     '#6B7280', 'Box',       80, CURRENT_TIMESTAMP(3));
