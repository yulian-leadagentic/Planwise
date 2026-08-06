/**
 * Read-only top-down organisation chart.
 *
 * A scan tool, not an editor: click a node card to jump into the Manage
 * view with that unit selected. Uses the SAME `['org','tree']` cache the
 * two-pane editor renders from — the parent passes the flat node list
 * in as a prop, so this component never issues its own request.
 *
 * Layout: CSS-only classic tree diagram. Each parent renders a card at
 * the top, a vertical drop, then a `<ul>` of children laid out
 * horizontally. Each child's pseudo-elements draw the vertical drop
 * from the shared horizontal segment down to its card. The horizontal
 * segment is a `::after` on the child wrapper spanning `left-0`/`right-0`;
 * the first-child truncates to `left-1/2` and last-child to `right-1/2`
 * so a two-parent row shows a clean H-connector without floating stubs.
 * An only-child collapses to `width: 0` naturally (same first + last
 * classes apply), leaving just the vertical trunk.
 *
 * Collapse state is component-local (`Set<number>`) — deliberately not
 * URL-persisted. This is a scan tool; a permalink to a specific
 * expansion state would bloat the URL for no real payoff.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Network as NetworkIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';

import { buildTree, type TreeItem } from './build-tree';

// Local minimal shape — kept structurally compatible with OrgNode from
// organization-page.tsx so the caller can pass its typed array straight
// in without adapters. Only the fields this view actually renders are
// listed; anything else the caller carries flows through untouched.
export interface OrgChartNode {
  id: number;
  name: string;
  code: string | null;
  parentId: number | null;
  sortOrder: number;
  manager: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    avatarUrl: string | null;
  } | null;
  memberCount: number;
  subtreeMemberCount: number;
  subtreeUnitCount: number;
}

export function OrgChart({
  nodes,
  onSelectUnit,
  onSwitchToManage,
}: {
  nodes: OrgChartNode[];
  onSelectUnit: (id: number) => void;
  /** Called by the empty-state affordance — switches to Manage view
   *  without creating anything, so the existing "New unit" flow is
   *  reachable in one click. */
  onSwitchToManage: () => void;
}) {
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  // Expand-all by default so the whole shape is visible on first paint;
  // users collapse manually via chevrons. Tracked as a Set of node ids
  // — anything NOT in the set is expanded, so newly-added units default
  // to expanded without a re-init.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
        <EmptyState
          icon={NetworkIcon}
          title="No org units yet"
          description="The chart is empty. Switch to Manage to create your first unit."
          action={
            <button
              type="button"
              onClick={onSwitchToManage}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Create the first unit
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 overflow-x-auto">
      {/* Multiple roots stack side-by-side under a synthetic row so the
          overall diagram never left-aligns awkwardly when there is more
          than one root. */}
      <ul className="flex justify-center items-start gap-8 min-w-max">
        {roots.map((r) => (
          <li key={r.node.id} className="flex flex-col items-center">
            <ChartSubtree
              item={r}
              collapsed={collapsed}
              onToggle={toggle}
              onSelect={onSelectUnit}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Recursive subtree renderer ────────────────────────────────────

function ChartSubtree({
  item,
  collapsed,
  onToggle,
  onSelect,
}: {
  item: TreeItem<OrgChartNode>;
  collapsed: Set<number>;
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const { node, children } = item;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const showChildren = hasChildren && !isCollapsed;

  return (
    <div className="flex flex-col items-center">
      <NodeCard
        node={node}
        hasChildren={hasChildren}
        isCollapsed={isCollapsed}
        onToggle={() => onToggle(node.id)}
        onSelect={() => onSelect(node.id)}
      />
      {showChildren && (
        <>
          {/* Vertical trunk: parent card bottom → children horizontal line */}
          <div
            aria-hidden="true"
            className="w-px h-6 bg-slate-300 dark:bg-slate-600"
          />
          <ul className="flex items-start justify-center">
            {children.map((child) => (
              <li
                key={child.node.id}
                className={cn(
                  'relative flex flex-col items-center px-4 pt-6',
                  // Vertical drop from shared horizontal line to child card top
                  'before:absolute before:top-0 before:left-1/2 before:h-6 before:w-px',
                  'before:bg-slate-300 dark:before:bg-slate-600',
                  // Horizontal segment joining siblings; first/last truncate to
                  // the centre so the H-connector ends at the outermost drops
                  // instead of floating past them.
                  'after:absolute after:top-0 after:h-px',
                  'after:bg-slate-300 dark:after:bg-slate-600',
                  'after:left-0 after:right-0',
                  'first:after:left-1/2',
                  'last:after:right-1/2',
                )}
              >
                <ChartSubtree
                  item={child}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ─── Node card ─────────────────────────────────────────────────────

function NodeCard({
  node,
  hasChildren,
  isCollapsed,
  onToggle,
  onSelect,
}: {
  node: OrgChartNode;
  hasChildren: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const subtreeExtra = Math.max(0, node.subtreeUnitCount - 1);

  return (
    <div className="relative flex flex-col items-stretch">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${node.name} in the editor`}
        className={cn(
          'group text-left w-56 rounded-[14px] border bg-white dark:bg-slate-900',
          'border-slate-200 dark:border-slate-700',
          'hover:border-slate-400 dark:hover:border-slate-500',
          'focus-visible:outline-none focus-visible:border-blue-500',
          'px-3.5 py-3 space-y-2 transition-colors',
        )}
      >
        {/* Title row — name + optional code chip */}
        <div className="flex items-start gap-2 min-w-0">
          <span className="flex-1 min-w-0 font-semibold text-[13px] text-slate-800 dark:text-slate-100 truncate">
            {node.name}
          </span>
          {node.code && (
            <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
              {node.code}
            </span>
          )}
        </div>

        {/* Manager row */}
        <div className="flex items-center gap-2 min-w-0">
          {node.manager ? (
            <>
              <UserAvatar
                firstName={node.manager.firstName}
                lastName={node.manager.lastName}
                avatarUrl={node.manager.avatarUrl}
                size="xs"
              />
              <span className="min-w-0 truncate text-[12px] text-slate-700 dark:text-slate-200">
                {node.manager.firstName} {node.manager.lastName}
              </span>
            </>
          ) : (
            <span className="text-[12px] italic text-slate-400 dark:text-slate-500">
              No manager
            </span>
          )}
        </div>

        {/* Counts row — direct members · subtree headcount */}
        <div className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
          {node.memberCount} direct · {node.subtreeMemberCount} below
        </div>
      </button>

      {/* Chevron — separate button so aria-expanded is authoritative and
          the click doesn't bubble into the card's select-and-navigate. */}
      {hasChildren && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
          className={cn(
            'absolute -bottom-3 left-1/2 -translate-x-1/2 z-10',
            'inline-flex items-center gap-1 px-1.5 h-6 rounded-full',
            'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
            'text-slate-500 dark:text-slate-400',
            'hover:border-slate-400 dark:hover:border-slate-500 hover:text-slate-700 dark:hover:text-slate-200',
            'focus-visible:outline-none focus-visible:border-blue-500',
          )}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          )}
          {isCollapsed && subtreeExtra > 0 && (
            <span className="font-mono tabular-nums text-[10px]">
              +{subtreeExtra} unit{subtreeExtra === 1 ? '' : 's'}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
