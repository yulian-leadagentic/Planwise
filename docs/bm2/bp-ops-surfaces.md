# BM 2 — BP ops surfaces + retire compat shims (build spec for CC)

> Follow-up to `docs/bm2/bp-model-refactor.md` (the model refactor, branch `refactor/bp-model`,
> merged to staging). Pairs with `docs/bm2/bp-contacts-design.md` (Contacts/import design) and
> `docs/bm2/bp-model-analysis.md` (the reasoning). This branch consumes the new model on the
> **frontend**, removes the temporary compat bridges, and adds the operational surfaces.
>
> Branch: `refactor/bp-ops-surfaces` (off updated `staging`, after the refactor lands).
> Follow `docs/PLANWISE_DESIGN_SYSTEM.md` (`planwise-design` skill) for all UI.
> **Do the phases in order** — Phase A first (it removes the shims everything else depends on
> being gone). Each phase is independently shippable and verifiable.

## Already built in `refactor/bp-model` — do NOT rebuild
Verified in the branch; this spec assumes these exist:
- **Backend accepts representation:** `POST`/`PATCH /project-partner-roles` accept + fully validate
  `contactPartyId` (must be a person; participant must be an org) and `onBehalfOfPartyId` (must be
  an org; participant must be a person). Schema FKs are `onDelete: SetNull`. **UI just needs to send
  them.**
- **`requiresContactPerson` flag** exists on Project Role Types (backend + the checkbox in
  `apps/web/src/features/admin/project-role-types-page.tsx`). Use it to drive the contact-person
  picker; don't re-add it.
- **Personal-email-domains admin** is done: CRUD at `partner-types.controller.ts`
  (`GET/POST/PATCH/DELETE /partner-types/personal-email-domains`, system rows protected) + the
  `PersonalEmailDomainsTab` in `partner-types-page.tsx`. The importer already ORs this catalog with
  the hard-coded fallback list. **Don't rebuild** — just consume it in the wizard (Phase D).
- **`BusinessPartnerDomain` table** exists and the dedup path reads it
  (`business-partners.service.ts` domain lookup). But there is **no CRUD endpoint** for it yet —
  that's Phase B.
- **Compat bridges to remove here:** the `business-partner-relationships` module (thin adapter,
  `PPR_ID_OFFSET = 1_000_000_000`) and the `toLegacyOutgoing()` / `attachLegacyOutgoing()` shim in
  `business-partners.service.ts` that synthesizes the legacy `outgoingRelationships` array.

## Guardrails
- Confirm each handler/shape in code before editing — grep first.
- Out of scope, do **not** touch: SSO, Delivery Planning, PERT, the BM2 Phase-1 bug pack areas.
- After each phase: `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web lint`
  and `pnpm --filter api build` (+ `prisma generate` if you touch schema in Phase B).
- The compat adapter offset trick only mattered while the FE spoke the legacy shape. Once Phase A is
  done and the adapter is deleted, that whole class of "which id space is this" bug is gone — don't
  reintroduce a synthetic-id scheme in the new code.

---

## Phase A — Frontend swap to the new endpoints + delete the compat shims
**Goal:** the frontend stops calling `/business-partner-relationships` and stops reading
`outgoingRelationships`; then both compat bridges are deleted.

**New endpoints to target:**
- **`/partner-relationships`** (`@Controller('partner-relationships')`, GET/GET:id/POST/PATCH/DELETE)
  — party↔party edges, incl. `worker_of` (employer). Body is `partyA`/`partyB`/`typeId`/validity.
- **`/project-partner-roles`** (`@Controller('project-partner-roles')`, GET/GET:id/POST/PATCH/DELETE)
  — project × party × role (project participation). Body incl. `projectId`/`partyId`/`roleId` and the
  optional `contactPartyId`/`onBehalfOfPartyId`.

**Callers to migrate (grep-verified list — reconfirm before editing):**
- `apps/web/src/features/partners/create-partner-modal.tsx` (~L205 POST) — employer link on create →
  `POST /partner-relationships` (`worker_of`).
- `apps/web/src/features/partners/partner-drawer.tsx` (~L407 delete, ~L415/1108 POST, ~L804/865
  delete; and the `outgoingRelationships` reads at ~L105/175/329/798/875) — employer + relationships
  tab → `partner-relationships`. Replace `outgoingRelationships` with the real relationship arrays
  from the BP payload (see "read side" below).
- `apps/web/src/features/partners/contacts-page.tsx` (`outgoingRelationships` reads at
  ~L50/249/546/709/725 — the `worker_of` employer lookups) → read from the real relationship shape.
- `apps/web/src/features/partners/partners-page.tsx` (~L57 `outgoingRelationships` type) → real shape.
- `apps/web/src/features/projects/project-detail/customer-contact-picker.tsx` (~L59 POST) → project
  participation now belongs in `project-partner-roles` (customer role) — repoint accordingly.
- `apps/web/src/features/projects/project-detail/project-bp-picker.tsx` (~L97 `outgoingRelationships`
  read for employer default; ~L119 POST) → `project-partner-roles` for participation; read employer
  from `partner-relationships` (`worker_of`).
- `apps/web/src/features/projects/project-detail/team-tab.tsx` (~L81 delete) → `project-partner-roles`.
- `apps/web/src/features/projects/project-form-page.tsx` (~L186 GET, ~L278/290 delete/POST — the
  customer relationship on the project form) → repoint to `project-partner-roles` (customer).

**Read side (backend):** update the BP list/drawer payload in `business-partners.service.ts` to
return the **real** shapes the FE now consumes — the party↔party relationships
(`partnerRelationshipsA` / incoming) and, where the drawer shows project participation, the
`projectPartnerRoles`. Remove `attachLegacyOutgoing()` from the read paths.

**Delete (only after the FE no longer references them):**
1. The `business-partner-relationships` module — controller, service (the adapter with `PPR_ID_OFFSET`),
   its DTOs, and its module registration.
2. `toLegacyOutgoing()` + `attachLegacyOutgoing()` and the `PPR_ID_OFFSET` constant in
   `business-partners.service.ts`.

**DoD:** `git grep -nE "business-partner-relationships|outgoingRelationships|toLegacyOutgoing|PPR_ID_OFFSET"`
returns **0** in `apps/web` and `apps/api`; employer + project participation still create/read/delete
correctly through the new endpoints; typecheck/build/lint green on both apps.

## Phase B — BusinessPartnerDomain CRUD + BP-drawer multi-domain manager
**Goal:** an org BP can own several domains, managed from its drawer (the table exists; no endpoint/UI
does yet).

1. **Backend — new endpoints** (put them on the `business-partners` module, scoped to a BP):
   - `GET  /business-partners/:id/domains` — list the BP's domains.
   - `POST /business-partners/:id/domains` `{ domain }` — add. Normalize (lowercase, strip scheme/`@`).
     **Reject a personal/free-email domain** (consult the same combined list the importer uses —
     hard-coded fallback OR the `personal_email_domains` catalog) with a clear message. Enforce the
     existing **global `@@unique(domain)`** — if it's already bound to another BP, 409 with which BP.
   - `DELETE /business-partners/:id/domains/:domainId` — remove.
   - Permission: same write/delete guard as other BP admin mutations.
2. **Frontend — `partner-drawer.tsx`:** for an **organization** BP, a "Domains" section (in the
   details tab or its own small tab): list chips, add-input, remove. Show a friendly error on
   personal-domain / already-bound. Invalidate the BP query on change. (Persons don't have domains —
   hide it for `partnerType === 'person'`.)

**DoD:** can add two domains to an org and remove one; adding a gmail-type domain is rejected; adding
a domain already owned by another BP is rejected with a pointer to that BP; the import dedup (Phase D)
matches on any of a BP's domains.

## Phase C — Add-participant pickers (consume `contactPartyId` / `onBehalfOfPartyId`)
**Goal:** the concrete UI for Yulian's scenario — an org participant can name its contact person, and
a person participant can be pinned to the employer they represent on THIS project. Backend is ready;
this is UI wiring on `POST/PATCH /project-partner-roles`.

Screens: `project-bp-picker.tsx`, `team-tab.tsx` / `team-table-view.tsx`, and
`customer-contact-picker.tsx` where relevant.

1. **Adding an ORG to a project:** if the chosen Project Role Type has `requiresContactPerson` (the
   flag from `refactor/bp-model`), show a **contact-person picker** — a person BP, ideally filtered to
   people with a `worker_of` edge to that org (allow "other" too). Send its id as `contactPartyId`.
   When not required, offer it as optional.
2. **Adding a PERSON to a project:** show an **on-behalf-of employer picker** (org BP). **Default** it
   to the person's current `worker_of` employer; if they have **multiple** active employers
   (allowed now — `worker_of.allowsMultiple = true`), require an explicit pick. Send `onBehalfOfPartyId`.
3. **Display** in the team list/table: `Org X — contact: Person C` and `Person C — on behalf of Org Y`.
   Read these from the `project-partner-roles` payload (include `contactParty` / `onBehalfOfParty` names
   in the read — add to the API include if not already returned).
4. Respect the backend validation (contact must be a person; on-behalf must be an org) — surface its
   error messages rather than duplicating the rules client-side.

**DoD:** add an org in a `requiresContactPerson` role → forced to pick a contact person → the row shows
"contact: …"; add a multi-employer person → forced to pick which employer → the row shows "on behalf of
…"; both round-trip and survive a refresh.

## Phase D — Excel contacts import wizard (domain dedup + conflict resolution)
> Per `bp-contacts-design.md` §2–3. Extends the existing `data-import` wizard
> (`apps/web/src/features/data-import/data-import-page.tsx`, `apps/web/src/api/data-import.api.ts`,
> and the `import-history-page.tsx`). The `data_imports.target` enum already includes `contacts`.

1. **Step 1 — Upload + column mapping.** Map user columns → `{ company, contactName, mobile, phone,
   email, address, roleOrDiscipline }`. No pre-formatting; **mappings saveable as a named preset.**
   Sample layout to default against: A=discipline/role, B=company, C=contact, D=mobile, E=phone,
   F=email, G=address.
2. **Step 2 — Resolve (dedup).** Per row derive **email domain** + **company name**. Match a BP by
   **domain first** (against `BusinessPartnerDomain`, any of a BP's domains), then normalized company
   name. **Personal-email domains** (the combined catalog + fallback) never define a company → route
   those rows to conflict resolution. Preview each row: create BP / link existing / needs-decision.
3. **Step 3 — Conflict-resolution screen** (ambiguous rows only): domain vs company-name disagree;
   shared office email for two people; freelancer/personal gmail; company-name typos → offer the
   closest existing BP to merge into.
4. **Step 4 — Commit (idempotent).** Create missing **org BPs** (typed — never default to "client"),
   create **person BPs** linked to their org via **`worker_of`** (`partner-relationships`), and attach
   each person to **this project** via **`project-partner-roles`** with the row's role/discipline. End
   with a summary (created / linked / skipped / errors) written to import history.

**External dependency (flag, don't block on it):** Amit's **real example Excel files** (incl. messy
"before" ones) are needed to lock the mapping defaults and the domain lists. Build the wizard so
mapping is fully user-driven against the documented sample columns; note in the PR that defaults will
be tuned once the files arrive.

**DoD:** import a sample sheet → orgs + contacts created/linked with correct typing, employer edges,
and project attachment; ambiguous rows land in conflict resolution; re-running the same file is a
no-op; history row written.

---

## Suggested split
If you want smaller PRs: **Phase A alone** is the highest-value, lowest-risk merge (kills the shims) —
ship it first. **B + C** together (both are BP-participation UX). **D** last (and partly gated on
Amit's files). Say which way you split.

## Definition of done (whole branch)
- 0 references to the compat adapter, `outgoingRelationships`, `toLegacyOutgoing`, `PPR_ID_OFFSET` in
  either app; the `business-partner-relationships` module is deleted.
- Multi-domain orgs manageable from the drawer; personal/duplicate domains rejected.
- Org/person project participation carries contact-person / on-behalf-of and shows it.
- Contacts import runs end-to-end against a sample sheet.
- Frozen list still clean; per-phase report of files changed + anything already present.

---

*Build spec 2026-08-13. Reference this file path in the CC prompt. Consumes `refactor/bp-model`.*
