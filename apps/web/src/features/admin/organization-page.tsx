/**
 * Organization admin — the two-pane editor for the org tree.
 *
 * Left pane: the unit tree, built from the flat list the backend
 * returns via GET /org-units. Chevrons expand/collapse; the row's
 * indent comes from the node's `depth`. Selected node highlighted.
 *
 * Right pane: the panel for whichever unit is selected. Shows the
 * unit's manager (with a searchable people-picker), and the direct
 * members list (users whose HOME unit is exactly this node) with an
 * inline Assign button + per-row Remove.
 *
 * All mutations invalidate the ['org'] query root so the tree and
 * counts stay consistent. Member assign / remove additionally
 * invalidates ['org', 'members', unitId] for the local table.
 *
 * The selected unit id is mirrored to the URL as `?unit=N` via
 * useDrawerRoute so refresh / share-a-link restores the selection.
 */

import { useMemo, useRef, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  Search,
  X,
  Users as UsersIcon,
  Network as NetworkIcon,
  Move as MoveIcon,
  Shield,
  UserPlus,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Modal } from '@/components/shared/modal';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { UserAvatar } from '@/components/shared/user-avatar';
import { DataTable } from '@/components/shared/data-table';
import type { ColumnDef } from '@tanstack/react-table';

// ─── Types (mirror the backend controller shapes) ──────────────────

interface OrgManager {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl: string | null;
}

interface OrgNode {
  id: number;
  name: string;
  code: string | null;
  parentId: number | null;
  path: string;
  depth: number;
  sortOrder: number;
  managerUserId: number | null;
  manager: OrgManager | null;
  memberCount: number;
  subtreeMemberCount: number;
  subtreeUnitCount: number;
}

interface OrgMember {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl: string | null;
  position: string | null;
}

interface UserRow {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl?: string | null;
}

const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus-visible:outline-none';

// ─── Page ─────────────────────────────────────────────────────────

export function OrganizationPage() {
  const { can, isAdmin } = usePermissions();
  const canRead = isAdmin || can('org', 'read');
  const canWrite = isAdmin || can('org', 'write');
  const canDelete = isAdmin || can('org', 'delete');

  const { drawerId: selectedId, openDrawer: selectUnit, closeDrawer: clearUnit } = useDrawerRoute('unit');

  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [creating, setCreating] = useState<{ parentId: number | null } | null>(null);
  const [renaming, setRenaming] = useState<OrgNode | null>(null);
  const [moving, setMoving] = useState<OrgNode | null>(null);

  const { data: nodes = [], isLoading } = useQuery<OrgNode[]>({
    queryKey: ['org', 'tree'],
    enabled: canRead,
    queryFn: () =>
      client.get('/org-units').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const invalidateOrg = () => queryClient.invalidateQueries({ queryKey: ['org'] });

  const removeUnit = useMutation({
    mutationFn: (id: number) => client.delete(`/org-units/${id}`).then((r) => r.data),
    onSuccess: (_res, id) => {
      invalidateOrg();
      if (selectedId === id) clearUnit();
      notify.success('Unit deleted', { code: 'ORG-UNIT-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to delete unit'),
  });

  if (!canRead) {
    return (
      <EmptyState
        icon={Shield}
        title="Permission required"
        description="You don't have access to the Organization admin surface. Ask an admin to grant you the 'org' module."
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Organization"
        description="Manage the org tree, unit managers, and each person's home unit."
      />

      <div className="flex flex-col lg:flex-row gap-5">
        {/* ─── Left pane: tree ───────────────────────────────────── */}
        <aside className="w-full lg:w-96 lg:shrink-0">
          <div className="lg:sticky lg:top-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-slate-500 dark:text-slate-400">
                {nodes.length === 0
                  ? 'No units yet — start with a root.'
                  : `${nodes.length} unit${nodes.length === 1 ? '' : 's'}`}
              </p>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setCreating({ parentId: selectedId ?? null })}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New unit
                </button>
              )}
            </div>

            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 max-h-[70vh] overflow-y-auto">
              {isLoading ? (
                <div className="p-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading…</div>
              ) : nodes.length === 0 ? (
                <div className="p-6 text-center text-[12px] text-slate-400 dark:text-slate-500">
                  No units yet.
                </div>
              ) : (
                <UnitTree
                  nodes={nodes}
                  selectedId={selectedId}
                  onSelect={selectUnit}
                  canWrite={canWrite}
                  canDelete={canDelete}
                  onRename={(n) => setRenaming(n)}
                  onMove={(n) => setMoving(n)}
                  onDelete={async (n) => {
                    const ok = await confirm(`Delete unit "${n.name}"?`, {
                      title: 'Delete unit',
                      description:
                        'The unit is soft-deleted. Units with children or members are rejected — reparent or reassign first.',
                      variant: 'danger',
                      confirmLabel: 'Delete',
                    });
                    if (ok) removeUnit.mutate(n.id);
                  }}
                />
              )}
            </div>
          </div>
        </aside>

        {/* ─── Right pane: unit panel ─────────────────────────────── */}
        <section className="flex-1 min-w-0">
          {selectedNode ? (
            <UnitPanel
              node={selectedNode}
              canWrite={canWrite}
              onCleared={clearUnit}
            />
          ) : (
            <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
              <EmptyState
                icon={NetworkIcon}
                title="Select a unit"
                description="Pick a node on the left to view its manager and members, or create a new unit to get started."
              />
            </div>
          )}
        </section>
      </div>

      {/* Create modal */}
      {creating && (
        <CreateUnitModal
          parentId={creating.parentId}
          nodes={nodes}
          onClose={() => setCreating(null)}
          onCreated={(newId) => {
            setCreating(null);
            selectUnit(newId);
          }}
        />
      )}

      {/* Rename modal */}
      {renaming && (
        <RenameUnitModal node={renaming} onClose={() => setRenaming(null)} />
      )}

      {/* Move modal */}
      {moving && (
        <MoveUnitModal node={moving} nodes={nodes} onClose={() => setMoving(null)} />
      )}
    </div>
  );
}

// ─── Tree (client-derived nested from flat list) ───────────────────

interface TreeItem {
  node: OrgNode;
  children: TreeItem[];
}

function buildTree(nodes: OrgNode[]): TreeItem[] {
  const byId = new Map<number, TreeItem>();
  for (const n of nodes) byId.set(n.id, { node: n, children: [] });
  const roots: TreeItem[] = [];
  for (const n of nodes) {
    const item = byId.get(n.id)!;
    if (n.parentId != null && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(item);
    } else {
      roots.push(item);
    }
  }
  const sortRec = (list: TreeItem[]) => {
    list.sort((a, b) => a.node.sortOrder - b.node.sortOrder || a.node.id - b.node.id);
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

function UnitTree({
  nodes,
  selectedId,
  onSelect,
  canWrite,
  canDelete,
  onRename,
  onMove,
  onDelete,
}: {
  nodes: OrgNode[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  canWrite: boolean;
  canDelete: boolean;
  onRename: (n: OrgNode) => void;
  onMove: (n: OrgNode) => void;
  onDelete: (n: OrgNode) => void;
}) {
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  // Expand-all by default so admins immediately see the shape. Users
  // can collapse manually via chevrons. Persist collapsed set in a
  // ref-in-state so toggle stays smooth.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul className="space-y-0.5" role="tree">
      {roots.map((r) => (
        <TreeRow
          key={r.node.id}
          item={r}
          collapsed={collapsed}
          onToggle={toggle}
          selectedId={selectedId}
          onSelect={onSelect}
          canWrite={canWrite}
          canDelete={canDelete}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  item,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  canWrite,
  canDelete,
  onRename,
  onMove,
  onDelete,
}: {
  item: TreeItem;
  collapsed: Set<number>;
  onToggle: (id: number) => void;
  selectedId: number | null;
  onSelect: (id: number) => void;
  canWrite: boolean;
  canDelete: boolean;
  onRename: (n: OrgNode) => void;
  onMove: (n: OrgNode) => void;
  onDelete: (n: OrgNode) => void;
}) {
  const { node, children } = item;
  const isSelected = selectedId === node.id;
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = children.length > 0;
  // Subtree summary — only surface it when the subtree is actually
  // larger than the node itself (avoids "1 unit · 0 people" noise on
  // leaves).
  const showSubtree = node.subtreeUnitCount > 1 || node.subtreeMemberCount > node.memberCount;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined}>
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-lg pr-1 py-[7px] transition-colors',
          isSelected
            ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800'
            : 'border border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/60',
        )}
        style={{ paddingLeft: `${8 + node.depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
            className="w-4 h-4 shrink-0 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="w-4 h-4 shrink-0" aria-hidden="true" />
        )}

        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex-1 min-w-0 flex items-center gap-2 text-left focus-visible:outline-none"
        >
          <span
            className={cn(
              'text-[13px] font-semibold truncate',
              isSelected ? 'text-blue-800 dark:text-blue-100' : 'text-slate-800 dark:text-slate-100',
            )}
          >
            {node.name}
          </span>
          {node.code && (
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0">
              {node.code}
            </span>
          )}
          {showSubtree && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate tabular-nums">
              {node.subtreeUnitCount} units · {node.subtreeMemberCount} people
            </span>
          )}
        </button>

        {/* Row actions — quiet until hover, keyboard-focusable */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
          {canWrite && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRename(node); }}
                aria-label={`Rename ${node.name}`}
                title="Rename"
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onMove(node); }}
                aria-label={`Move ${node.name}`}
                title="Move"
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <MoveIcon className="h-3 w-3" aria-hidden="true" />
              </button>
            </>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(node); }}
              aria-label={`Delete ${node.name}`}
              title="Delete"
              className="w-6 h-6 rounded flex items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {hasChildren && !isCollapsed && (
        <ul role="group" className="space-y-0.5">
          {children.map((c) => (
            <TreeRow
              key={c.node.id}
              item={c}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              canWrite={canWrite}
              canDelete={canDelete}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Right pane: unit panel ────────────────────────────────────────

function UnitPanel({
  node,
  canWrite,
  onCleared,
}: {
  node: OrgNode;
  canWrite: boolean;
  onCleared: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [pickerMode, setPickerMode] = useState<'manager' | 'assign' | null>(null);
  // The `onCleared` prop currently only fires on delete elsewhere;
  // silence unused-arg warning without changing the public surface.
  void onCleared;

  const { data: members = [], isLoading: membersLoading } = useQuery<OrgMember[]>({
    queryKey: ['org', 'members', node.id],
    queryFn: () =>
      client.get(`/org-units/${node.id}/members`).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const invalidateOrg = () => queryClient.invalidateQueries({ queryKey: ['org'] });
  const invalidateMembers = () => queryClient.invalidateQueries({ queryKey: ['org', 'members', node.id] });

  const setManager = useMutation({
    mutationFn: (userId: number | null) =>
      client.patch(`/org-units/${node.id}/manager`, { userId }).then((r) => r.data),
    onSuccess: () => {
      invalidateOrg();
      notify.success('Manager updated', { code: 'ORG-MANAGER-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update manager'),
  });

  const assignUserToUnit = useMutation({
    mutationFn: (userId: number) =>
      client.patch(`/users/${userId}/org-unit`, { orgUnitId: node.id }).then((r) => r.data),
    onSuccess: () => {
      invalidateOrg();
      invalidateMembers();
      notify.success('Assigned to unit', { code: 'ORG-ASSIGN-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to assign user'),
  });

  const removeMember = useMutation({
    mutationFn: (userId: number) =>
      client.patch(`/users/${userId}/org-unit`, { orgUnitId: null }).then((r) => r.data),
    onSuccess: () => {
      invalidateOrg();
      invalidateMembers();
      notify.success('Removed from unit', { code: 'ORG-ASSIGN-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove member'),
  });

  const columns: ColumnDef<OrgMember, unknown>[] = useMemo(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (m) => `${m.firstName} ${m.lastName}`,
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="flex items-center gap-2 min-w-0">
              <UserAvatar firstName={m.firstName} lastName={m.lastName} avatarUrl={m.avatarUrl} size="xs" />
              <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">
                {m.firstName} {m.lastName}
              </span>
            </div>
          );
        },
      },
      {
        id: 'email',
        header: 'Email',
        accessorFn: (m) => m.email,
        cell: ({ row }) => (
          <span className="text-slate-600 dark:text-slate-300 truncate">{row.original.email}</span>
        ),
      },
      {
        id: 'position',
        header: 'Position',
        accessorFn: (m) => m.position ?? '',
        cell: ({ row }) => (
          <span className="text-slate-600 dark:text-slate-300 truncate">
            {row.original.position || <span className="italic text-slate-400 dark:text-slate-500">—</span>}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => {
          if (!canWrite) return null;
          const m = row.original;
          return (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={async () => {
                  const ok = await confirm(
                    `Remove ${m.firstName} ${m.lastName} from ${node.name}?`,
                    {
                      title: 'Remove from unit',
                      description: 'The user keeps their account — only their home unit is cleared.',
                      variant: 'danger',
                      confirmLabel: 'Remove',
                    },
                  );
                  if (ok) removeMember.mutate(m.id);
                }}
                className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded px-2 py-1"
              >
                Remove
              </button>
            </div>
          );
        },
      },
    ],
    [canWrite, confirm, node.id, node.name, removeMember],
  );

  return (
    <div className="space-y-5 rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
      {/* Header — unit name + code chip + subtree summary */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 truncate">
              {node.name}
            </h2>
            {node.code && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-[5px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                {node.code}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400 tabular-nums">
            {node.memberCount} direct member{node.memberCount === 1 ? '' : 's'} · {node.subtreeUnitCount} unit{node.subtreeUnitCount === 1 ? '' : 's'} in subtree · {node.subtreeMemberCount} people below
          </p>
        </div>
      </div>

      {/* Manager row */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Manager
        </label>
        <div className="flex items-center flex-wrap gap-2">
          {node.manager ? (
            <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2 py-1.5">
              <UserAvatar
                firstName={node.manager.firstName}
                lastName={node.manager.lastName}
                avatarUrl={node.manager.avatarUrl}
                size="xs"
              />
              <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                {node.manager.firstName} {node.manager.lastName}
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">{node.manager.email}</span>
            </span>
          ) : (
            <span className="text-[13px] italic text-slate-400 dark:text-slate-500">No manager assigned</span>
          )}
          {canWrite && (
            <>
              <button
                type="button"
                onClick={() => setPickerMode('manager')}
                className="text-[12px] font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-200 px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                {node.manager ? 'Change manager' : 'Assign manager'}
              </button>
              {node.manager && (
                <button
                  type="button"
                  onClick={() => setManager.mutate(null)}
                  className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Members section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">Members</h3>
            <p className="text-[12px] text-slate-500 dark:text-slate-400">
              People whose home unit is exactly this node. Subordinates via nested units aren't listed here.
            </p>
          </div>
          {canWrite && (
            <button
              type="button"
              onClick={() => setPickerMode('assign')}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> Assign to unit
            </button>
          )}
        </div>

        <DataTable
          columns={columns}
          data={members}
          isLoading={membersLoading}
          emptyMessage="No direct members yet — assign someone to get started."
        />
      </div>

      {pickerMode && (
        <PeoplePickerModal
          title={pickerMode === 'manager' ? 'Assign manager' : 'Assign to unit'}
          confirmLabel={pickerMode === 'manager' ? 'Set manager' : 'Assign'}
          onClose={() => setPickerMode(null)}
          onPick={async (user) => {
            if (pickerMode === 'manager') {
              await setManager.mutateAsync(user.id);
            } else {
              await assignUserToUnit.mutateAsync(user.id);
            }
            setPickerMode(null);
          }}
        />
      )}
    </div>
  );
}

// ─── People picker modal ───────────────────────────────────────────

function PeoplePickerModal({
  title,
  confirmLabel,
  onClose,
  onPick,
}: {
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onPick: (user: UserRow) => void | Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: users = [], isLoading } = useQuery<UserRow[]>({
    queryKey: ['users-active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/users').then((r) => {
        // The users endpoint sometimes ships { data: [] } and sometimes
        // a raw array — match the same defensive unwrap the task-drawer
        // assignee picker uses.
        const d = r.data?.data ?? r.data;
        if (Array.isArray(d)) return d;
        if (Array.isArray(d?.data)) return d.data;
        return [];
      }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return (
        full.includes(q) ||
        u.firstName?.toLowerCase().includes(q) ||
        u.lastName?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  const submit = async () => {
    if (pickedId == null) return;
    const user = users.find((u) => u.id === pickedId);
    if (!user) return;
    setSubmitting(true);
    try {
      await onPick(user);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description="Search by name or email, then confirm."
      widthClass="w-[520px] max-w-[95vw]"
      initialFocusRef={searchRef}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pickedId == null || submitting}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {submitting ? 'Saving…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400 dark:placeholder:text-slate-500 text-slate-800 dark:text-slate-100"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {isLoading ? (
            <div className="p-4 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading users…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-slate-400 dark:text-slate-500">
              No people match "{search}".
            </div>
          ) : (
            filtered.slice(0, 100).map((u) => {
              const picked = pickedId === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setPickedId(u.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:bg-blue-50 dark:focus-visible:bg-blue-900/30',
                    picked
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                  )}
                >
                  <UserAvatar firstName={u.firstName} lastName={u.lastName} avatarUrl={u.avatarUrl} size="xs" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {u.firstName} {u.lastName}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{u.email}</p>
                  </div>
                  {picked && (
                    <span className="text-[11px] font-bold text-blue-600 dark:text-blue-300 uppercase tracking-wider">
                      Selected
                    </span>
                  )}
                </button>
              );
            })
          )}
          {filtered.length > 100 && (
            <div className="p-2 text-center text-[11px] text-slate-400 dark:text-slate-500">
              Showing first 100 — refine your search to narrow the list.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Create / Rename / Move modals ─────────────────────────────────

function CreateUnitModal({
  parentId,
  nodes,
  onClose,
  onCreated,
}: {
  parentId: number | null;
  nodes: OrgNode[];
  onClose: () => void;
  onCreated: (newId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [selectedParent, setSelectedParent] = useState<number | null>(parentId);
  const nameRef = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: () =>
      client
        .post('/org-units', {
          name: name.trim(),
          code: code.trim() || undefined,
          parentId: selectedParent,
        })
        .then((r) => r.data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['org'] });
      notify.success('Unit created', { code: 'ORG-UNIT-CREATE-200' });
      const created = res?.data ?? res;
      if (created?.id) onCreated(created.id);
      else onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to create unit'),
  });

  const canSave = name.trim().length > 0 && !create.isPending;

  const parentOptions = useMemo(() => nodes.slice().sort((a, b) => a.path.localeCompare(b.path)), [nodes]);

  return (
    <Modal
      open
      onClose={onClose}
      title="New unit"
      description="Create a unit anywhere in the tree. You can move it later."
      initialFocusRef={nameRef}
      widthClass="w-[480px] max-w-[95vw]"
      isDirty={name.trim().length > 0 || code.trim().length > 0}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!canSave}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create unit'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Name<span className="text-red-500"> *</span>
          </label>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Engineering"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Code
            <span className="ml-1 text-[11px] font-normal text-slate-400 dark:text-slate-500">
              (short identifier — optional)
            </span>
          </label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. ENG"
            className={cn(inputClass, 'font-mono text-[12px]')}
          />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Parent
          </label>
          <select
            value={selectedParent == null ? '' : String(selectedParent)}
            onChange={(e) => setSelectedParent(e.target.value === '' ? null : Number(e.target.value))}
            className={inputClass}
          >
            <option value="">Root (no parent)</option>
            {parentOptions.map((n) => (
              <option key={n.id} value={n.id}>
                {' '.repeat(n.depth)}
                {n.name}
                {n.code ? ` (${n.code})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function RenameUnitModal({ node, onClose }: { node: OrgNode; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(node.name);
  const [code, setCode] = useState(node.code ?? '');
  const nameRef = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: () =>
      client
        .patch(`/org-units/${node.id}`, {
          name: name.trim(),
          // Explicit null clears the code; empty string is treated as "clear".
          code: code.trim() === '' ? null : code.trim(),
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] });
      notify.success('Unit updated', { code: 'ORG-UNIT-UPDATE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update unit'),
  });

  const dirty = name.trim() !== node.name || (code.trim() || null) !== (node.code ?? null);
  const canSave = name.trim().length > 0 && dirty && !save.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Rename "${node.name}"`}
      description="Change the display name or short code. Reparenting lives on the Move action."
      initialFocusRef={nameRef}
      widthClass="w-[440px] max-w-[95vw]"
      isDirty={dirty}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!canSave}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">Name</label>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
            Code
            <span className="ml-1 text-[11px] font-normal text-slate-400 dark:text-slate-500">
              (leave blank to clear)
            </span>
          </label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={cn(inputClass, 'font-mono text-[12px]')}
          />
        </div>
      </div>
    </Modal>
  );
}

function MoveUnitModal({
  node,
  nodes,
  onClose,
}: {
  node: OrgNode;
  nodes: OrgNode[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Backend rejects cycles with 400 too, but pre-filtering avoids the
  // round-trip: strip self AND every descendant (any node whose path
  // startsWith the moving node's path). Order by materialised path so
  // the flat list still reads top-down.
  const options = useMemo(
    () =>
      nodes
        .filter((n) => n.id !== node.id && !n.path.startsWith(node.path))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [nodes, node.id, node.path],
  );
  const [newParentId, setNewParentId] = useState<number | null>(node.parentId);

  const move = useMutation({
    mutationFn: () =>
      client.patch(`/org-units/${node.id}/move`, { newParentId }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] });
      notify.success('Unit moved', { code: 'ORG-UNIT-MOVE-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to move unit'),
  });

  const dirty = newParentId !== node.parentId;
  const canSave = dirty && !move.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Move "${node.name}"`}
      description="Pick a new parent. Descendants of this unit are hidden — moving under one of them would create a cycle."
      widthClass="w-[480px] max-w-[95vw]"
      isDirty={dirty}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => move.mutate()}
            disabled={!canSave}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {move.isPending ? 'Moving…' : 'Move'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 block">
          New parent
        </label>
        <select
          value={newParentId == null ? '' : String(newParentId)}
          onChange={(e) => setNewParentId(e.target.value === '' ? null : Number(e.target.value))}
          className={inputClass}
        >
          <option value="">Root (no parent)</option>
          {options.map((n) => (
            <option key={n.id} value={n.id}>
              {' '.repeat(n.depth)}
              {n.name}
              {n.code ? ` (${n.code})` : ''}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          Current parent: {node.parentId == null ? 'Root' : nodes.find((n) => n.id === node.parentId)?.name ?? '—'}
        </p>
        {/* Small hint next to the picker so the disallowed choice isn't a mystery */}
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/20 text-[11px] text-amber-800 dark:text-amber-200 px-2.5 py-2 flex items-start gap-2">
          <UsersIcon className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Members stay with the unit — they move with it. Subtree access paths and manager assignments update
            automatically on save.
          </span>
        </div>
      </div>
    </Modal>
  );
}
