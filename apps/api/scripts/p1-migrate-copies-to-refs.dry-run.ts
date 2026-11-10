/**
 * P1 · Reference model — DRY-RUN planner.
 *
 *   # from apps/api/
 *   pnpm exec dotenv -e .env -- node -r ts-node/register scripts/p1-migrate-copies-to-refs.dry-run.ts
 *   # or (self-loads .env):
 *   node -r ts-node/register scripts/p1-migrate-copies-to-refs.dry-run.ts
 *
 * READ-ONLY. Scans every non-deliverable template (i.e. Template.type !==
 * 'task_list' — composing templates: combined/zone_template/team_template)
 * and reports what the Phase-2 migration would do:
 *
 *   • For each composing template, find every `TemplateTask` and
 *     `TemplateZoneTask` row carrying `deliverableTemplateId != null`
 *     (the FK-sourced path — "copied tasks tagged with a deliverable FK").
 *   • Additionally resolve legacy rows WITHOUT the FK whose description
 *     carries the legacy `[SERVICE:<name>]` marker, mirroring
 *     `TemplatesService.resolveDeliverableTemplateByMarker` exactly.
 *     Rows the resolver returns `null` for are collected into a
 *     `legacy_unresolvable` list — the plan does NOT halt; Yulian
 *     decides manual backfill / leave-as-legacy per-row.
 *   • Group FK-sourced + marker-resolved rows by
 *     `(templateId, parentZoneId_or_root, deliverableTemplateId)`
 *     — each group becomes ONE reference-slot (a `TemplateZone` with
 *     `linkedTaskTemplateId=<deliverable>` at the group's parent).
 *   • Skip groups that already have a sibling zone with
 *     `linkedTaskTemplateId=<deliverable>` at the same parent — the
 *     Phase-2 migration is idempotent per-group.
 *   • Print planned writes as JSON + a human-readable summary, plus a
 *     BEFORE / AFTER zones tree for the template with the largest
 *     plan count.
 *
 * This script does NOT write. It never calls any `prisma.*.create`,
 * `.update` or `.delete`. It never touches projects or their tasks
 * (`Task` / `TaskDependency`). All destructive side-effects live in
 * the Phase-2 executor:
 *
 *   apps/api/scripts/p1-migrate-copies-to-refs.ts  ← TO BE WRITTEN
 *
 * which will run under Yulian's approval, against a fresh backup, on
 * staging only — same pattern DN-1 followed for the deliverable-FK
 * backfill.
 */

// ─── Inline .env loader (dotenv is not a direct apps/api dep) ──────────────
// Loads DATABASE_URL (and friends) from apps/api/.env BEFORE PrismaClient is
// imported — Prisma Client reads process.env at module init.
import * as fs from 'fs';
import * as path from 'path';
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch {
  /* .env missing — fall through, Prisma will error if DATABASE_URL is unset */
}

import { PrismaClient } from '@prisma/client';

// ─── Marker helpers — ports of apps/api/.../marker-phase-resolver.ts and
//     apps/api/.../templates.service.ts :: resolveDeliverableTemplateByMarker.
//     MUST stay byte-for-byte equivalent to the service so the Phase-2
//     executor uses the same resolution rules the dry-run reports.

/** Extract the `<name>` from a task's `[SERVICE:<name>]` description marker, or null. */
function extractServiceMarker(description: string | null | undefined): string | null {
  if (!description) return null;
  const m = description.match(/^\[SERVICE:(.+)\]$/);
  return m ? m[1] : null;
}

type MarkerCatalogEntry = { id: number; name: string; phaseId: number | null };

/**
 * Mirror of TemplatesService.resolveDeliverableTemplateByMarker (private).
 * Matches `catalog.name = marker` first, then `name LIKE marker\%` (the
 * `base\detail` rename form). Preference rules:
 *   1. Phase match (if the task has `phaseId`).
 *   2. Prefer exact over prefix.
 *   3. Still > 1 → return null (never guess).
 * Zero candidates → null. Templates-side only: caller feeds a catalog
 * pre-filtered to `type='task_list', deletedAt=null`.
 */
function resolveDeliverableTemplateByMarker(
  description: string | null | undefined,
  taskPhaseId: number | null | undefined,
  catalog: MarkerCatalogEntry[],
): number | null {
  const marker = extractServiceMarker(description);
  if (!marker) return null;

  const exact = catalog.filter((t) => t.name === marker);
  const prefix = catalog.filter((t) => t.name.startsWith(`${marker}\\`));
  const all = [
    ...exact.map((t) => ({ ...t, matchKind: 'exact' as const })),
    ...prefix.map((t) => ({ ...t, matchKind: 'prefix' as const })),
  ];
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].id;

  if (taskPhaseId != null) {
    const samePhase = all.filter((c) => c.phaseId === taskPhaseId);
    if (samePhase.length === 1) return samePhase[0].id;
    if (samePhase.length > 1) {
      const exactPhase = samePhase.find((c) => c.matchKind === 'exact');
      if (exactPhase) return exactPhase.id;
    }
  }
  if (exact.length === 1) return exact[0].id;
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

type GroupKey = string; // `${templateId}:${parentZoneId ?? 'root'}:${deliverableTemplateId}`
type Provenance = 'fk' | 'marker';
type RowKind = 'task' | 'zone_task';

interface SourcedCopyRow {
  id: number;
  source: Provenance;
  kind: RowKind;
}

interface PlannedSlot {
  key: GroupKey;
  templateId: number;
  templateName: string;
  templateType: string;
  parentZoneId: number | null;
  parentZoneName: string | null;
  deliverableTemplateId: number;
  deliverableName: string;
  deliverableCode: string | null;
  sources: Provenance[]; // ["fk"] | ["marker"] | ["fk","marker"]
  copiedTaskSource: 'template_tasks' | 'template_zone_tasks' | 'mixed';
  copiedTaskIds: SourcedCopyRow[];
  wouldCreateZoneSlot: {
    name: string;
    parentZoneId: number | null;
    linkedTaskTemplateId: number;
  };
  wouldDeleteTaskRows: {
    templateTaskIds: number[];
    templateZoneTaskIds: number[];
  };
  skipReason?: 'already_linked';
}

interface UnresolvableRow {
  templateId: number;
  templateName: string;
  rowId: number;
  rowKind: RowKind;
  description: string;
  phaseId: number | null;
  zoneId: number | null;
  zoneName: string | null;
}

const prisma = new PrismaClient();

async function main() {
  // 1) Catalog for the marker resolver (one query, reused per row).
  const catalogRows = await prisma.template.findMany({
    where: { deletedAt: null, type: 'task_list' },
    select: { id: true, name: true, phaseId: true },
  });
  const catalog: MarkerCatalogEntry[] = catalogRows.map((r) => ({
    id: r.id,
    name: r.name,
    phaseId: r.phaseId,
  }));

  // 2) Composing templates (type !== 'task_list') with tasks + zones +
  //    zone tasks. `description` + `phaseId` are needed for the marker
  //    resolver on null-FK rows.
  const composing = await prisma.template.findMany({
    where: { deletedAt: null, type: { not: 'task_list' } },
    select: {
      id: true,
      name: true,
      type: true,
      templateTasks: {
        select: {
          id: true,
          code: true,
          description: true,
          phaseId: true,
          deliverableTemplateId: true,
        },
      },
      templateZones: {
        select: {
          id: true,
          name: true,
          parentId: true,
          linkedTaskTemplateId: true,
          templateZoneTasks: {
            select: {
              id: true,
              code: true,
              description: true,
              phaseId: true,
              deliverableTemplateId: true,
            },
          },
        },
      },
    },
  });

  // 3) Pre-pass: resolve legacy `[SERVICE:...]` markers on null-FK rows.
  //    Produces, per-template, maps { rowId -> resolvedDeliverableTemplateId }
  //    for later grouping (source='marker'), plus a flat unresolvable list.
  const legacyUnresolvable: UnresolvableRow[] = [];
  const markerResolvedTaskIds = new Map<number, number>(); // templateTask.id -> deliverableTemplateId
  const markerResolvedZoneTaskIds = new Map<number, number>(); // templateZoneTask.id -> deliverableTemplateId

  for (const tpl of composing) {
    for (const tt of tpl.templateTasks) {
      if (tt.deliverableTemplateId != null) continue;
      if (!extractServiceMarker(tt.description)) continue;
      const resolved = resolveDeliverableTemplateByMarker(
        tt.description,
        tt.phaseId,
        catalog,
      );
      if (resolved != null) {
        markerResolvedTaskIds.set(tt.id, resolved);
      } else {
        legacyUnresolvable.push({
          templateId: tpl.id,
          templateName: tpl.name,
          rowId: tt.id,
          rowKind: 'task',
          description: tt.description ?? '',
          phaseId: tt.phaseId,
          zoneId: null,
          zoneName: null,
        });
      }
    }
    for (const tz of tpl.templateZones) {
      for (const tzt of tz.templateZoneTasks) {
        if (tzt.deliverableTemplateId != null) continue;
        if (!extractServiceMarker(tzt.description)) continue;
        const resolved = resolveDeliverableTemplateByMarker(
          tzt.description,
          tzt.phaseId,
          catalog,
        );
        if (resolved != null) {
          markerResolvedZoneTaskIds.set(tzt.id, resolved);
        } else {
          legacyUnresolvable.push({
            templateId: tpl.id,
            templateName: tpl.name,
            rowId: tzt.id,
            rowKind: 'zone_task',
            description: tzt.description ?? '',
            phaseId: tzt.phaseId,
            zoneId: tz.id,
            zoneName: tz.name,
          });
        }
      }
    }
  }

  // 4) Deliverable (task_list) side lookups for display names/codes.
  //    Includes both the FK-sourced deliverableIds and the ones the
  //    marker resolver returned.
  const deliverableIds = new Set<number>();
  for (const t of composing) {
    for (const tt of t.templateTasks) {
      if (tt.deliverableTemplateId) deliverableIds.add(tt.deliverableTemplateId);
    }
    for (const tz of t.templateZones) {
      for (const tzt of tz.templateZoneTasks) {
        if (tzt.deliverableTemplateId) deliverableIds.add(tzt.deliverableTemplateId);
      }
    }
  }
  for (const d of markerResolvedTaskIds.values()) deliverableIds.add(d);
  for (const d of markerResolvedZoneTaskIds.values()) deliverableIds.add(d);

  const deliverables =
    deliverableIds.size > 0
      ? await prisma.template.findMany({
          where: { id: { in: Array.from(deliverableIds) } },
          select: { id: true, name: true, code: true, type: true },
        })
      : [];
  const deliverableById = new Map(deliverables.map((d) => [d.id, d]));

  // 5) Grouping — unchanged key shape; now each row carries a Provenance
  //    tag so each group's `sources` reports where its rows came from.
  const plan: PlannedSlot[] = [];
  const skipped: PlannedSlot[] = [];
  let totalFkSourced = 0;
  let totalMarkerResolved = 0;

  for (const tpl of composing) {
    const zoneById = new Map(tpl.templateZones.map((z) => [z.id, z]));

    // Idempotence index: already-linked (parent, deliverable) pairs.
    const existingLinkedKeys = new Set<GroupKey>();
    for (const z of tpl.templateZones) {
      if (!z.linkedTaskTemplateId) continue;
      const parentKey = z.parentId == null ? 'root' : String(z.parentId);
      existingLinkedKeys.add(`${tpl.id}:${parentKey}:${z.linkedTaskTemplateId}`);
    }

    type Group = {
      templateTaskRows: SourcedCopyRow[];
      templateZoneTaskRows: SourcedCopyRow[];
      parentZoneId: number | null;
      deliverableTemplateId: number;
      sources: Set<Provenance>;
    };
    const groups = new Map<GroupKey, Group>();

    const ensureGroup = (key: GroupKey, parentZoneId: number | null, deliverableTemplateId: number): Group => {
      let g = groups.get(key);
      if (!g) {
        g = {
          templateTaskRows: [],
          templateZoneTaskRows: [],
          parentZoneId,
          deliverableTemplateId,
          sources: new Set<Provenance>(),
        };
        groups.set(key, g);
      }
      return g;
    };

    // Root TemplateTasks.
    for (const tt of tpl.templateTasks) {
      let deliverableId: number | null = null;
      let source: Provenance | null = null;
      if (tt.deliverableTemplateId != null) {
        deliverableId = tt.deliverableTemplateId;
        source = 'fk';
      } else if (markerResolvedTaskIds.has(tt.id)) {
        deliverableId = markerResolvedTaskIds.get(tt.id)!;
        source = 'marker';
      }
      if (deliverableId == null || source == null) continue;

      const key = `${tpl.id}:root:${deliverableId}`;
      const g = ensureGroup(key, null, deliverableId);
      g.templateTaskRows.push({ id: tt.id, source, kind: 'task' });
      g.sources.add(source);
      if (source === 'fk') totalFkSourced++;
      else totalMarkerResolved++;
    }

    // Zone-scoped TemplateZoneTasks.
    for (const tz of tpl.templateZones) {
      for (const tzt of tz.templateZoneTasks) {
        let deliverableId: number | null = null;
        let source: Provenance | null = null;
        if (tzt.deliverableTemplateId != null) {
          deliverableId = tzt.deliverableTemplateId;
          source = 'fk';
        } else if (markerResolvedZoneTaskIds.has(tzt.id)) {
          deliverableId = markerResolvedZoneTaskIds.get(tzt.id)!;
          source = 'marker';
        }
        if (deliverableId == null || source == null) continue;

        const key = `${tpl.id}:${tz.id}:${deliverableId}`;
        const g = ensureGroup(key, tz.id, deliverableId);
        g.templateZoneTaskRows.push({ id: tzt.id, source, kind: 'zone_task' });
        g.sources.add(source);
        if (source === 'fk') totalFkSourced++;
        else totalMarkerResolved++;
      }
    }

    // Materialize groups into PlannedSlots.
    for (const [key, g] of groups) {
      const deliverable = deliverableById.get(g.deliverableTemplateId);
      // Integrity gap: id points at a non-task_list (or deleted) Template.
      // Flag, don't plan a slot for it.
      if (!deliverable || deliverable.type !== 'task_list') continue;

      const parentZoneName =
        g.parentZoneId == null ? null : zoneById.get(g.parentZoneId)?.name ?? null;

      const allRows: SourcedCopyRow[] = [
        ...g.templateTaskRows,
        ...g.templateZoneTaskRows,
      ];
      const copiedTaskSource: 'template_tasks' | 'template_zone_tasks' | 'mixed' =
        g.templateTaskRows.length > 0 && g.templateZoneTaskRows.length > 0
          ? 'mixed'
          : g.templateTaskRows.length > 0
            ? 'template_tasks'
            : 'template_zone_tasks';

      const slot: PlannedSlot = {
        key,
        templateId: tpl.id,
        templateName: tpl.name,
        templateType: tpl.type,
        parentZoneId: g.parentZoneId,
        parentZoneName,
        deliverableTemplateId: g.deliverableTemplateId,
        deliverableName: deliverable.name,
        deliverableCode: deliverable.code ?? null,
        sources: Array.from(g.sources).sort(),
        copiedTaskSource,
        copiedTaskIds: allRows,
        wouldCreateZoneSlot: {
          name: deliverable.name,
          parentZoneId: g.parentZoneId,
          linkedTaskTemplateId: g.deliverableTemplateId,
        },
        wouldDeleteTaskRows: {
          templateTaskIds: g.templateTaskRows.map((r) => r.id),
          templateZoneTaskIds: g.templateZoneTaskRows.map((r) => r.id),
        },
      };

      if (existingLinkedKeys.has(key)) {
        slot.skipReason = 'already_linked';
        skipped.push(slot);
      } else {
        plan.push(slot);
      }
    }
  }

  // 6) Summary scalars.
  const affectedTemplates = new Set(plan.map((p) => p.templateId));
  const rowsToDelete = plan.reduce(
    (n, p) =>
      n +
      p.wouldDeleteTaskRows.templateTaskIds.length +
      p.wouldDeleteTaskRows.templateZoneTaskIds.length,
    0,
  );

  // 7) Pick the composing template with the largest plan count for the
  //    BEFORE/AFTER sample tree.
  const perTemplatePlanCount = new Map<number, number>();
  for (const p of plan) {
    perTemplatePlanCount.set(p.templateId, (perTemplatePlanCount.get(p.templateId) ?? 0) + 1);
  }
  let sampleTemplateId: number | null = null;
  let sampleCount = 0;
  for (const [tid, cnt] of perTemplatePlanCount) {
    if (cnt > sampleCount) {
      sampleCount = cnt;
      sampleTemplateId = tid;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Output
  // ───────────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('P1 · Reference model — DRY-RUN planner');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Planned zone-slot creates:');
  if (plan.length === 0) {
    console.log('  (none — every composing template is already clean)');
  } else {
    for (const p of plan) {
      const parent =
        p.parentZoneId == null
          ? 'ROOT'
          : `zone #${p.parentZoneId} (${p.parentZoneName ?? '?'})`;
      const srcIds = p.copiedTaskIds.map((r) => `${r.id}(${r.source})`).join(',');
      console.log(
        `  tpl #${p.templateId} "${p.templateName}" [${p.templateType}] @ ${parent} ` +
          `→ deliverable #${p.deliverableTemplateId} "${p.deliverableName}"` +
          `  (${p.copiedTaskSource}, sources=[${p.sources.join(',')}], ${p.copiedTaskIds.length} copy rows → remove: ${srcIds})`,
      );
    }
  }
  console.log('');
  console.log(`Skipped (already linked at same parent): ${skipped.length}`);
  for (const s of skipped) {
    console.log(
      `  tpl #${s.templateId} "${s.templateName}" @ ` +
        `${s.parentZoneId == null ? 'ROOT' : `zone #${s.parentZoneId}`} ` +
        `→ deliverable #${s.deliverableTemplateId} already linked, no-op ` +
        `(copy rows still present: ${s.copiedTaskIds.map((r) => `${r.id}(${r.source})`).join(',')})`,
    );
  }
  console.log('');
  console.log('Legacy [SERVICE:...] rows the marker resolver could not resolve:');
  console.log(`  count: ${legacyUnresolvable.length}`);
  for (const u of legacyUnresolvable.slice(0, 10)) {
    const where = u.zoneId == null ? 'ROOT' : `zone #${u.zoneId} (${u.zoneName ?? '?'})`;
    console.log(
      `  tpl #${u.templateId} "${u.templateName}" ${u.rowKind} #${u.rowId} @ ${where} ` +
        `phaseId=${u.phaseId ?? 'null'} desc=${JSON.stringify(u.description)}`,
    );
  }
  if (legacyUnresolvable.length > 10) {
    console.log(`  … (${legacyUnresolvable.length - 10} more not printed)`);
  }
  console.log('');
  console.log('━━━ JSON plan ━━━');
  console.log(
    JSON.stringify(
      {
        plan,
        skipped,
        legacy_unresolvable: legacyUnresolvable,
      },
      null,
      2,
    ),
  );
  console.log('━━━ END JSON plan ━━━');
  console.log('');

  // ─── Sample zones tree: BEFORE / AFTER for ONE template ──────────────────
  if (sampleTemplateId != null) {
    const tpl = composing.find((t) => t.id === sampleTemplateId)!;
    const zoneById = new Map(tpl.templateZones.map((z) => [z.id, z]));
    const rootZones = tpl.templateZones.filter((z) => z.parentId == null);
    const samplePlan = plan.filter((p) => p.templateId === sampleTemplateId);

    // Build maps: parent-key → planned slots at that parent, and
    // rowId → provenance tag ("fk"/"marker") for dt annotation.
    const slotsAtRoot: PlannedSlot[] = samplePlan.filter((p) => p.parentZoneId == null);
    const slotsByZone = new Map<number, PlannedSlot[]>();
    for (const p of samplePlan) {
      if (p.parentZoneId == null) continue;
      const arr = slotsByZone.get(p.parentZoneId) ?? [];
      arr.push(p);
      slotsByZone.set(p.parentZoneId, arr);
    }
    const dtByRowKey = new Map<string, { dt: number; src: Provenance }>();
    for (const p of samplePlan) {
      for (const r of p.copiedTaskIds) {
        dtByRowKey.set(`${r.kind}:${r.id}`, { dt: p.deliverableTemplateId, src: r.source });
      }
    }

    const beforeLines: string[] = [];
    const afterLines: string[] = [];

    beforeLines.push(`Template #${tpl.id} "${tpl.name}"`);
    afterLines.push(`Template #${tpl.id} "${tpl.name}"`);

    const printBeforeNode = (
      zoneOrNull: typeof tpl.templateZones[number] | null,
      prefix: string,
      isLast: boolean,
      isRootLevel: boolean,
    ) => {
      const branch = isRootLevel ? '' : isLast ? '└── ' : '├── ';
      const nextPrefix = isRootLevel ? '' : prefix + (isLast ? '    ' : '│   ');
      if (zoneOrNull == null) {
        // ROOT — render root-level TemplateTasks only.
        const rootTasks = tpl.templateTasks;
        for (let i = 0; i < rootTasks.length; i++) {
          const tt = rootTasks[i];
          const dtInfo = dtByRowKey.get(`task:${tt.id}`);
          const dtLabel =
            dtInfo != null
              ? `(dt=${dtInfo.dt}${dtInfo.src === 'marker' ? ',marker' : ''})`
              : tt.deliverableTemplateId != null
                ? `(dt=${tt.deliverableTemplateId})`
                : '';
          const last = i === rootTasks.length - 1 && rootZones.length === 0;
          beforeLines.push(
            `${last ? '└── ' : '├── '}Task ${tt.code || '-'} ${dtLabel}`.trimEnd(),
          );
        }
        return;
      }
      beforeLines.push(`${prefix}${branch}Zone "${zoneOrNull.name}" (#${zoneOrNull.id})`);
      const tasks = zoneOrNull.templateZoneTasks;
      const childZones = tpl.templateZones.filter((z) => z.parentId === zoneOrNull.id);
      for (let i = 0; i < tasks.length; i++) {
        const tzt = tasks[i];
        const isTaskLast = i === tasks.length - 1 && childZones.length === 0;
        const dtInfo = dtByRowKey.get(`zone_task:${tzt.id}`);
        const dtLabel =
          dtInfo != null
            ? `(dt=${dtInfo.dt}${dtInfo.src === 'marker' ? ',marker' : ''})`
            : tzt.deliverableTemplateId != null
              ? `(dt=${tzt.deliverableTemplateId})`
              : '';
        beforeLines.push(
          `${nextPrefix}${isTaskLast ? '└── ' : '├── '}Task ${tzt.code || '-'} ${dtLabel}`.trimEnd(),
        );
      }
      for (let i = 0; i < childZones.length; i++) {
        printBeforeNode(childZones[i], nextPrefix, i === childZones.length - 1, false);
      }
    };

    const printAfterNode = (
      zoneOrNull: typeof tpl.templateZones[number] | null,
      prefix: string,
      isLast: boolean,
      isRootLevel: boolean,
    ) => {
      const branch = isRootLevel ? '' : isLast ? '└── ' : '├── ';
      const nextPrefix = isRootLevel ? '' : prefix + (isLast ? '    ' : '│   ');
      if (zoneOrNull == null) {
        // ROOT — render planned root slots + any surviving root tasks.
        const remainingRoot = tpl.templateTasks.filter(
          (tt) => !dtByRowKey.has(`task:${tt.id}`),
        );
        const slots = slotsAtRoot;
        const total = slots.length + remainingRoot.length + rootZones.length;
        let idx = 0;
        for (const s of slots) {
          idx++;
          const last = idx === total;
          afterLines.push(
            `${last ? '└── ' : '├── '}Zone-slot "${s.deliverableName}" (linked→#${s.deliverableTemplateId})`,
          );
          afterLines.push(
            `${last ? '    ' : '│   '}    [tasks rendered read-only via linked ref]`,
          );
        }
        for (const tt of remainingRoot) {
          idx++;
          const last = idx === total;
          afterLines.push(`${last ? '└── ' : '├── '}Task ${tt.code || '-'}`);
        }
        return;
      }
      afterLines.push(`${prefix}${branch}Zone "${zoneOrNull.name}" (#${zoneOrNull.id})`);
      const slotsHere = slotsByZone.get(zoneOrNull.id) ?? [];
      const remainingTasks = zoneOrNull.templateZoneTasks.filter(
        (tzt) => !dtByRowKey.has(`zone_task:${tzt.id}`),
      );
      const childZones = tpl.templateZones.filter((z) => z.parentId === zoneOrNull.id);
      const total = slotsHere.length + remainingTasks.length + childZones.length;
      let idx = 0;
      for (const s of slotsHere) {
        idx++;
        const last = idx === total;
        afterLines.push(
          `${nextPrefix}${last ? '└── ' : '├── '}Zone-slot "${s.deliverableName}" (linked→#${s.deliverableTemplateId})`,
        );
        afterLines.push(
          `${nextPrefix}${last ? '    ' : '│   '}    [tasks rendered read-only via linked ref]`,
        );
      }
      for (const tt of remainingTasks) {
        idx++;
        const last = idx === total;
        afterLines.push(`${nextPrefix}${last ? '└── ' : '├── '}Task ${tt.code || '-'}`);
      }
      for (let i = 0; i < childZones.length; i++) {
        idx++;
        const last = idx === total;
        printAfterNode(childZones[i], nextPrefix, last, false);
      }
    };

    // Build BEFORE: root-level tasks, then root-level zones.
    const hasRootTasks = tpl.templateTasks.length > 0;
    if (hasRootTasks) printBeforeNode(null, '', false, true);
    for (let i = 0; i < rootZones.length; i++) {
      printBeforeNode(rootZones[i], '', i === rootZones.length - 1, false);
    }
    // Build AFTER.
    const remainingRootTasksAfter = tpl.templateTasks.filter(
      (tt) => !dtByRowKey.has(`task:${tt.id}`),
    );
    if (slotsAtRoot.length > 0 || remainingRootTasksAfter.length > 0) {
      printAfterNode(null, '', false, true);
    }
    for (let i = 0; i < rootZones.length; i++) {
      printAfterNode(rootZones[i], '', i === rootZones.length - 1, false);
    }

    // Side-by-side two-column print, column width padded to the widest
    // BEFORE line. ASCII-safe; the zone names themselves may be RTL — we
    // keep them as-is (bidi-safe terminal rendering is the terminal's job).
    const colWidth = Math.max(32, ...beforeLines.map((l) => [...l].length)) + 2;
    const pad = (s: string, w: number) => {
      const visibleLen = [...s].length;
      return s + ' '.repeat(Math.max(0, w - visibleLen));
    };
    const maxLines = Math.max(beforeLines.length, afterLines.length);

    console.log('━━━ Sample zones tree (template with largest planned slot count) ━━━');
    console.log(`(template #${sampleTemplateId}, planned slots: ${sampleCount})`);
    console.log('');
    console.log(`${pad('BEFORE', colWidth)}AFTER`);
    for (let i = 0; i < maxLines; i++) {
      const b = beforeLines[i] ?? '';
      const a = afterLines[i] ?? '';
      console.log(`${pad(b, colWidth)}${a}`);
    }
    console.log('━━━ END sample zones tree ━━━');
    console.log('');
  } else {
    console.log('━━━ Sample zones tree: (nothing planned, skipping) ━━━');
    console.log('');
  }

  console.log('Tally:');
  console.log(
    JSON.stringify(
      {
        total_templates_affected: affectedTemplates.size,
        total_groups_to_create: plan.length,
        total_rows_to_delete: rowsToDelete,
        total_groups_skipped_idempotent: skipped.length,
        total_fk_sourced: totalFkSourced,
        total_marker_resolved: totalMarkerResolved,
        legacy_unresolvable_count: legacyUnresolvable.length,
        legacy_unresolvable_sample: legacyUnresolvable.slice(0, 10),
        projects_touched: 0, // by design
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
