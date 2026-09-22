# Planwise QA3 — RUN NOW (CC, no decisions required)

**Date:** 2026-09-22 · branch `staging`. These are the Wave-1 items that need **no** decision from Yulian. Execute in order. Full context: `docs/bm2/qa3-status.md`.

**Global rules:** verify-first; DoD is live on staging (HTTP/log/tester), not a green build; if you can't verify live, STOP and report; one concern per commit; keep design-system + dark mode on any UI. **Do NOT** touch the category tables, do NOT run any data cleanup, do NOT build multi-select — those wait on Yulian's D1/D2.

## 1. Close Gate #6a — no data cleanup  ✅/🟡
The integrity scan (P20/P26/P18) came back clean — zero orphans, zero nulls, ~20ms. Record #6a as **closed: no data to fix**. No migration. (Doc/state only — confirm it's noted.)

## 2. Remove the TEMP integrity endpoint  ✅ DONE (commit 3322bca)
`qa3-integrity.controller.ts` removed + wiring in `admin.module.ts`. Confirm the route 404s live if not already.

## 3. Load-path query-timeout guard (wedge defense-in-depth)  ✅ DONE (commit 3322bca)
`apps/api/src/common/query-timeout.ts` added + applied on `planning.service.ts`. Confirm live: heavy read still 200, a stuck query returns a clean 5xx (not a hang).

## 4. Customer-block click-test (PR-021 symptom, runtime)
Via Chrome on staging (your session): open `/projects/new`, pick a Project Category, and confirm the **customer field is selectable on the first try, no refresh**. Report yes/no + a screenshot. (This is read-only verification — no code unless it reproduces, in which case STOP and report the failing request.)

## 5. Wedge-watch (ongoing, no code)
Leave Commit-1 instrumentation running. When the next wedge occurs, immediately capture: (a) the vitals **rss trend** over the hours before it — a steady climb = memory/connection leak; (b) Railway's **restart/OOM events** at that timestamp; (c) whether the death log shows `received SIGTERM` (graceful/platform) or nothing (SIGKILL/external OOM). Report those three — that's how we pin the real cause. Do not force a wedge.

## Report back
Remaining: #1 confirm closed, #4 yes/no + screenshot, #5 armed. #2 and #3 already shipped in 3322bca — just confirm live.

## NEXT after run-now → Commit 3
Decisions are now LOCKED. Do Commit 3 from **`docs/bm2/qa3-commit3.md`** (3A rewire tabs → 3B data reconciliation, PAUSE before deletes → 3C multi-select).
⚠️ **IGNORE the "COMMIT 3" section in `qa3-master-run.md` — it is SUPERSEDED.** That older section says "bind Category ← ProjectType", which is already done and is NOT the fix. The real root cause (the "Project Categories" tab writes to `service_types`, not `project_types`) and the correct fix live only in `qa3-commit3.md` + `qa3-status.md`.
Also: `git add` the untracked `docs/bm2/qa3-*.md` so the current specs are versioned.
