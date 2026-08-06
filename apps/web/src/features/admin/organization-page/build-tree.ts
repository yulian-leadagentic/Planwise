/**
 * Flat → nested tree builder for the Organization admin surface.
 *
 * The backend ships org units as a flat list ordered by materialised
 * path, and every consumer needs a parent-linked nested shape. Extracting
 * this here keeps the Manage view (left-pane list) and the Chart view
 * (top-down diagram) driven by the SAME algorithm — so subtree ordering
 * and root selection cannot drift between the two surfaces.
 *
 * The shape is intentionally generic (`TreeNodeLike`): any record with
 * `id`, `parentId`, and `sortOrder` can be nested. Callers keep their
 * own richer node type (OrgNode carries counts, manager, etc.) and the
 * generic passes it through unchanged.
 */

export interface TreeNodeLike {
  id: number;
  parentId: number | null;
  sortOrder: number;
}

export interface TreeItem<T extends TreeNodeLike> {
  node: T;
  children: TreeItem<T>[];
}

export function buildTree<T extends TreeNodeLike>(nodes: T[]): TreeItem<T>[] {
  const byId = new Map<number, TreeItem<T>>();
  for (const n of nodes) byId.set(n.id, { node: n, children: [] });
  const roots: TreeItem<T>[] = [];
  for (const n of nodes) {
    const item = byId.get(n.id)!;
    if (n.parentId != null && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(item);
    } else {
      roots.push(item);
    }
  }
  const sortRec = (list: TreeItem<T>[]) => {
    list.sort((a, b) => a.node.sortOrder - b.node.sortOrder || a.node.id - b.node.id);
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}
