# Planwise QA3 — Wave Plan (how to run the master sequence)

**Date:** 2026-09-17 · **For:** Yulian + CC
Run the 11 commits from `claude/planwise-qa3-master-run.md` in **4 waves**. Each wave is **one CC run** that ends with a status report + live verification by Danielle/Tzlil **before** the next wave starts. Global run rules, DoDs, locked decisions, and the two safety gates all live in the master-run doc — this file only sets the wave boundaries and the kickoff line for each.

Wave gate rule: **do not start wave N+1 until wave N's DoDs are verified live on staging.** If a DoD can't be met live, CC stops and reports rather than marking it done.

---

## 🌊 Wave 1 — Stabilize (unblock testing + project creation)
**Commits:** 1 (wedge instrumentation) → 2 (auth/logout/project-load) → 3 (category + customer-block).
**Why first:** nothing else can be trusted while testers get thrown out, and project creation is blocked by the category/customer bug. This is the critical path.
**Entry:** none. **Exit / DoD:** 1660 + Baer Yarkon load <2s/200; no first-click failures; plain F5 keeps session; checklist items 29 (SSO) + 32 (refresh-logout) pass; New-Project categories == Types table, multi-select, customer never blocked. Verified by Danielle + Tzlil.
**Kickoff to CC:**
> Read `claude/planwise-qa3-master-run.md` and `claude/planwise-auth-wedge-deep-dive.md`. Execute **Wave 1 = Commits 1, 2, 3** only, in order, under the global run rules. Honor both safety gates in Commit 2 (backup before any data cleanup, staging only, never prod; describe the SW/cache change before applying). Stop after Commit 3 and post a live-verification report. Do not start Wave 2.

## 🌊 Wave 2 — Core data & model
**Commits:** 4 (cost chain: PR-029→004→031→035) → 5 (Zone/Service model: PR-032/034/042/020) → 6 (Deliverable identity + Execution dedup: PR-041).
**Why second:** the deepest structural work; depends on a stable auth layer and clean test projects from Wave 1. Yulian's priority inside this wave: the group-by-Zone (Zone>Building>Level) change.
**Entry:** Wave 1 verified; a **clean** test project chosen (not 1660). **Exit / DoD:** rate→hours→cost correct at every rollup + budget-vs-cost on card/top-row; template zone-type tagging + Zone>Building>Level grouping + service association + no-zone progress; deliverable keyed by id (rename keeps link, Execution shows each once, hours preserved). Verified live.
**Kickoff to CC:**
> Wave 1 is verified. Execute **Wave 2 = Commits 4, 5, 6** from `claude/planwise-qa3-master-run.md`, in order, under the global run rules. Use a clean test project, never 1660. Stop after Commit 6 and post a live-verification report.

## 🌊 Wave 3 — People & work surfaces
**Commits:** 7 (team picker + contact scoping: PR-023/026/028/038) → 8 (contact-add screen: Job Title **closed list**, Discipline, Main Role label; PR-039) → 9 (Execution/Planning: PR-033/040 + verify 017/018).
**Why third:** builds on the model from Wave 2 (roles, services, zones) and the locked contact decisions.
**Entry:** Wave 2 verified. **Exit / DoD:** role picker role-filtered; project contacts project/org-scoped; quick-assign auto-adds; multi-org consultants preserved; contact-add matches locked decisions + Discipline list; near-due filter works; zone delete works + blocked when hours exist. Verified live.
**Kickoff to CC:**
> Wave 2 is verified. Execute **Wave 3 = Commits 7, 8, 9** from `claude/planwise-qa3-master-run.md`, in order, under the global run rules. Locked decisions: Job Title = closed list only; contacts = one table + AMC filter. Stop after Commit 9 and post a report.

## 🌊 Wave 4 — Ops & design integration
**Commits:** 10 (Activity per-project + Drive link-only + Contacts import fix) → 11 (design integration: one-table+AMC filter+copy-emails, progress reconcile, "!" indicator).
**Why last:** mostly post-go-live polish + waits on Tzlil's Figma screens (delivered one at a time). Drive is deliberately scoped to link-only.
**Entry:** Wave 3 verified; Tzlil's screens arriving. **Exit / DoD:** per-project Activity logs create/status/assignee; project↔Drive-folder link works; contacts import reads a real file without error; contacts one-table+filter+copy-emails live; single reconciled progress number; no-due-date tasks visible with compact indicator. Dark-mode checked.
**Kickoff to CC:**
> Wave 3 is verified. Execute **Wave 4 = Commits 10, 11** from `claude/planwise-qa3-master-run.md`, under the global run rules and the `planwise-design` skill. Implement structural pieces now; leave pure visual polish to match Tzlil's Figma as it lands. Post a final closeout report.

---

## Sequencing notes
- **Go-live gate (Yulian):** Waves 1–3 (create-project-and-operate) must be solid **before** data migration. Wave 4 can trail.
- **Design track is parallel:** Tzlil sends screens continuously; CC folds visual changes into whichever wave is active without blocking on the full batch.
- **Next review:** Thursday 08:30. Aim to have Wave 1 verified and Wave 2 in progress by then.
- The hourly staging uptime check is already running and will alert on any outage during these waves.
