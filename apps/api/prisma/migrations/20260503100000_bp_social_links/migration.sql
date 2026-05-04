-- Social profile URLs on Business Partners (especially useful for contacts).
-- All nullable, all VARCHAR(500) to fit deeplinks with query params.

ALTER TABLE `business_partners`
  ADD COLUMN `linkedin_url`  VARCHAR(500) NULL AFTER `website`,
  ADD COLUMN `facebook_url`  VARCHAR(500) NULL AFTER `linkedin_url`,
  ADD COLUMN `twitter_url`   VARCHAR(500) NULL AFTER `facebook_url`,
  ADD COLUMN `instagram_url` VARCHAR(500) NULL AFTER `twitter_url`;
