-- ZT-4: flip the default on Zone.zoneType and TemplateZone.zoneType
-- from legacy 'zone' → 'building'. ZT-3 remapped every existing row to a
-- catalog code (site/building/level/wing); keeping the DEFAULT on the
-- legacy value would re-introduce "(legacy)" labels on any newly created
-- zone that doesn't pick a type explicitly.
--
-- The enum members themselves are NOT dropped here — the follow-up
-- migration (20261011010000_drop_legacy_zonetype_enum) handles that
-- once we've confirmed no legacy rows remain in staging/production.

ALTER TABLE `zones` ALTER COLUMN `zone_type` SET DEFAULT 'building';
ALTER TABLE `template_zones` ALTER COLUMN `zone_type` SET DEFAULT 'building';
