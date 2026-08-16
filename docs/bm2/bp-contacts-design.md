# BM 2 — Business Partners, Contacts & Excel Import — design (for CC, later phase)

> BP typing is its **own task**; the **Excel import is designed together with the BP work**.
> Builds on the existing `business-partners` + `partner-types` modules and the 4-step `data-import` wizard.

## 1 · Core model
- **Business Partner (BP) = company/organization.** Add/confirm a `partnerType`:
  `client | developer | supervision | partner | consultant` (extend as needed). Nothing defaults to "client".
- **Contact = a person, ALWAYS linked to a parent BP.** Never free-floating.
- A contact can hold a **role** and/or **discipline** on a project (`ProjectPartnerRole`) **without** a
  system user. Optional future: give a consultant a user to see/report tasks.
- **Identity keys:** BP by **email domain** (a BP may own **multiple** domains), then normalized company
  name; Contact by email (fallback: name within its BP). Contact email may be **shared** (office inbox).

### BP typing — the separate task
Ensure the `partnerType` set exists on BP, expose it in BP admin + create/edit, default nothing to "client".
Do this before/with the import (the dedup relies on it).

## 2 · Excel contacts import (from inside a project) — reuse the data-import wizard
- **Step 1 — Upload + column mapping.** User maps columns → `{ company, contactName, mobile, phone,
  email, address, roleOrDiscipline }`. No pre-formatting required; mappings saveable as a named preset.
  (Sample columns: A=discipline/role tag, B=company, C=contact person, D=mobile, E=phone, F=email, G=address.)
- **Step 2 — Resolve (dedup).** Per row derive **email domain** + **company name**. Match BP by **domain
  first**, then normalized company name. **Personal-email domains** (gmail/yahoo/outlook/…) never define a
  company domain → those rows go to conflict resolution. Preview: create BP / link existing / needs-decision.
- **Step 3 — Conflict resolution screen** (only ambiguous rows): domain vs company-name disagree; shared
  office email for two people; freelancer/personal gmail; company-name typos → offer closest existing BP.
- **Step 4 — Commit.** Create missing BPs (typed) + Contacts (linked to their BP) → attach each contact to
  **this project** with its role/discipline. Idempotent; end with a summary (created/linked/skipped/errors).

## 3 · Dedup rules
1. Real company domain → BP (create if new).
2. Personal email → conflict resolution.
3. Same domain, different company text → warn, pick canonical BP.
4. Same company, two domains (office + gmail) → allow **multiple domains per BP**.
5. Contact email may be shared → email not unique across contacts.

## 4 · Team/Contacts screen changes (pair with feature E)
- **Cards view = only "Projects"** (internal people with a system user) · **Table view = all
  role/discipline contacts** (external / budget partners).
- Rename leader role **"BIM Coordinator" → "Project Leader"**; order Project Leader → Projects → roles.
- Per-person **indicator**: existing system user vs not.
- Compact square tiles in Cards. Table fields: Name · Mobile · Telephone · Email · Address · Comments,
  with **Group by Role / Discipline**.

## 5 · To finalize
- **Real example Excel files from Amit** (incl. messy "before" ones) to lock mapping defaults + domain lists.
- Confirm the `partnerType` value set. Confirm **multiple domains per BP** is acceptable.

## 6 · Build order
1. **BP typing** (separate task). 2. **Team/Contacts screen split**. 3. **Excel import** (once files land).
