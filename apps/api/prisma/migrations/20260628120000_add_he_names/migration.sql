-- Add Hebrew name fields on both User and BusinessPartner so the People
-- admin / Contacts admin can record an employee's or contact's name in
-- both English and Hebrew. The Hebrew columns are NULLABLE: existing
-- rows keep their English-only names; admins fill in Hebrew over time
-- as they update records.
--
-- The search query (users.service + business-partners.service) walks
-- BOTH languages so an admin can type "Yossi" OR "יוסי" and find the
-- same person. (T3.3, 2026-06-28)
ALTER TABLE `users`
  ADD COLUMN `first_name_he` VARCHAR(100) NULL,
  ADD COLUMN `last_name_he`  VARCHAR(100) NULL;

ALTER TABLE `business_partners`
  ADD COLUMN `first_name_he` VARCHAR(100) NULL,
  ADD COLUMN `last_name_he`  VARCHAR(100) NULL;
