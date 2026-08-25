# BM2 · Planning 3-level grouping

**Branch:** `feat/planning-3level-group` off `staging`.

**Frozen (do NOT touch):** SSO, PERT, Delivery Planning **scheduling / date-shift** logic (`deliverable-planning-tab.tsx`).
`planning-modal.tsx` itself is fair game.

## Context

The planning grid supports two-level grouping today: a **primary** dimension
(Zone / Deliverable / Service / None) and an optional **secondary** dimension
applied inside each primary group. Users want a **third** level, e.g.
`Zone → Deliverable → Service`.

The recursive renderer `HierarchicalZoneGroup` already supports arbitrary
zone-depth, and `ProjectRootDeliverableGroup` already renders a nested sub-group
card via `PlanningSubGroupContext`. This is a **UI + config addition on top of
existing recursion**, not a rewrite.

### Legacy value mapping (keep intact)

Codebase quirk: the user-visible label **Deliverable** maps to the internal
value `'service'`, and the user-visible label **Service** maps to the internal
value `'phase'`. Do **not** rename the internal values — it would ripple
through zone/deliverable/service resolution across the app.

User-visible labels stay: **Zone**, **Deliverable**, **Service**, **None**.

## Decision

**Option 2 — ordered `groupOrder: GroupDim[]` array.**

Rationale:
- The recursive renderer already accepts a `depth` prop, so telling it "at
  every level, consult `groupOrder[depth]`" is a small hop from "one primary
  dim + one sub-context dim".
- Removes the `isSubGroup` boolean cul-de-sac that today caps recursion at
  depth 2. Replacing it with a `groupDepth` number is a mechanical change with
  a small surface (two recursion sites).
- Extends naturally to N levels if the client asks for a fourth in future.
- Contains the refactor: existing `groupBy` / `subGroupBy` semantics are kept
  by deriving them from `groupOrder` (see "Legacy compatibility" below), so
  the rest of `planning-modal.tsx` — sort, filters, add-task, DnD, hidden
  columns, "kind" chip resolution — is unchanged.

Fallback if this ballooned: Option 1 (`thirdGroupBy` field) would work, but
would leave two boolean recursion caps in place — every future level would
mean another discriminated switch.

## State

```ts
type GroupDim = 'zone' | 'service' | 'phase';
// [] means "no grouping" (matches old groupBy='none').
// Length 1 = primary only; length 2 = primary + secondary; length 3 = tri-level.
const [groupOrder, setGroupOrder] = useState<GroupDim[]>(['zone']);
```

Legacy derived values used only for readability in the (unchanged) column-hide
memo and "kind"-chip picker at the top-level render:

```ts
const primaryGroup = groupOrder[0] ?? 'none';
const secondaryGroup = groupOrder[1] ?? '';
const tertiaryGroup = groupOrder[2] ?? '';
```

## Context threading

```ts
type PlanningSubGroupCtx = {
  order: GroupDim[];                          // full order incl. primary at [0]
  bucketize: (tasks: any[], dim: GroupDim) => SubGroupBucket[];
};
```

- `bucketize` is dim-parameterized (already implemented today as
  `bucketizeForSub`) — just exposed via context instead of being pre-bound to
  a single dim.
- Recursion walks `order[depth+1]`. When `order[depth+1]` is undefined, the
  card renders its leaf task table.

## Renderer threading

- `HierarchicalZoneGroup` (Zone recursion): its `depth` prop counts **zone-nesting depth**
  (visual indent for sub-zones), not group-order depth. A Zone group always sits
  at group-order depth 0, so its direct tasks are bucketed by `order[1]` when
  that entry exists.
- `ProjectRootDeliverableGroup` gets a new `groupDepth: number` prop
  (defaulting to 0). When it renders its children:
  - If `order[groupDepth + 1]` exists → bucketize by that dim and recurse into
    `ProjectRootDeliverableGroup` with `groupDepth={groupDepth + 1}`.
  - Otherwise → render the flat leaf task table.
- The `isSubGroup` boolean is removed — `groupDepth > 0` is now the "am I
  nested?" flag (used to suppress dndId / drag handles on nested cards).
- `ProjectRootGroup` (orphan tasks, zoneId = null): consumer of the same
  context; sub-grouping already routed through `subCtx.bucketize` — updated to
  the depth-aware pattern.

## Add-task context (unchanged shape, threaded per level)

- `TaskAddContext` from `fix/planning-add-template` (commit `22cdb7c`) stays
  as-is: `{ zoneId, projectDeliverableId, deliverableTemplateId, phaseId }`.
- Every group card assembles a `groupAddContext` from `contextZoneId`,
  `editableDeliverableId`, `editableTemplateId`, `contextPhaseId` — already
  the pattern. Recursion continues to inherit missing fields from the parent
  via `sg.zoneId ?? contextZoneId` etc., so at level 3 the leaf's Add menu
  prefills L1 zone + L2 deliverable + L3 service.

## Rollup completion (unchanged util)

`rollupCompletion(tasks)` from `fix/completion-model-align` (`057ae8b`) is a
flat-task-list util. Each group card already flattens the descendants it
represents (its `tasks` prop is the flat set of leaf tasks under it), so
percentages are correct at every level with no util change.

## Selector UI

Three selectors in the grouping toolbar (Primary / Secondary / Tertiary):
- Secondary is hidden when Primary is None.
- Tertiary is hidden when Secondary is None (or missing).
- Each selector only offers dimensions not selected in an outer level, plus
  "None" as a stop.
- Flipping an outer level to a colliding value clears the inner levels
  (the same guard the existing two-level dropdown already applies).

Visual: three `select` elements separated by `/`, matches the current
two-level toolbar style — no new dialog primitives, no new components.

## URL / persistence

Existing `groupBy` and `subGroupBy` in `planning-modal.tsx` are React state
only (grepped — no `useSearchParams` in this file). The new `groupOrder` stays
React state for consistency; no URL persistence is added. The DoD line about
"two-level saved URLs" is moot because none exist today.

If URL persistence is desired later, `groupOrder` would encode as
`?group=zone.service.phase` — trivial to add in a follow-up.

## Legacy compatibility

- The old two-level UI mapped {groupBy: 'zone', subGroupBy: 'service'} → tree
  `Zone → Deliverable`. The new UI represents the same as
  `groupOrder = ['zone', 'service']` and renders identically.
- No serialized user state on disk / in URL to migrate.

## DoD

- Third selector present, only offers unused dimensions; hidden when the
  level above is None.
- `Zone → Deliverable → Service` (and permutations) renders correctly, three
  levels deep, leaves show tasks.
- Add-task from any depth prefills the correct context.
- Rollup completion % correct at every intermediate header (already works —
  each card holds the flat task set for its subtree).
- Frozen list untouched — `deliverable-planning-tab.tsx` PERT / date logic
  unchanged (verified by git diff on that path being empty).

## Files expected to change

- `apps/web/src/features/projects/planning-modal.tsx`
  - `SubGroupDim` renamed to `GroupDim`; state to `groupOrder`.
  - `PlanningSubGroupCtx` reshaped to `{ order, bucketize }`.
  - `HierarchicalZoneGroup` reads `subCtx.order[1]` (not a bound dim).
  - `ProjectRootDeliverableGroup` gains `groupDepth`, drops `isSubGroup`.
  - `ProjectRootGroup` threads `groupDepth={1}` when consuming the ctx.
  - Toolbar: two selects → three selects; state driven by `groupOrder`.

No other files change.
