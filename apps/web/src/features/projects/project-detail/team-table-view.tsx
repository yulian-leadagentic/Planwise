import { useState } from 'react';
import type { ProjectTeamData } from './types';

/**
 * Flat table view of every person touching the project. Aggregates:
 *   • Internal team members (Project Team section)
 *   • Customer (the org itself — single row)
 *   • Customer contacts (people working at the customer org)
 *   • Role assignments (Architect / Engineer / etc.)
 *
 * Dedupes by businessPartnerId so a person assigned to multiple
 * role-types appears once with all roles listed in one cell.
 */
export function TeamTableView({ team }: { team: ProjectTeamData }) {
  // Build a single deduped row list keyed by businessPartnerId.
  const rows = (() => {
    const byId = new Map<number, {
      bpId: number;
      displayName: string;
      email: string | null;
      phone: string | null;
      kinds: Set<string>;
      roles: Set<string>;
    }>();

    const upsert = (
      bpId: number,
      data: { displayName: string; email: string | null; phone: string | null },
      kind: string,
      role?: string,
    ) => {
      const existing = byId.get(bpId);
      if (existing) {
        existing.kinds.add(kind);
        if (role) existing.roles.add(role);
        return;
      }
      byId.set(bpId, {
        bpId,
        displayName: data.displayName,
        email: data.email,
        phone: data.phone,
        kinds: new Set([kind]),
        roles: new Set(role ? [role] : []),
      });
    };

    for (const m of team.projectTeam) {
      upsert(m.businessPartnerId, m, 'Project Team', m.roleInContext ?? undefined);
    }
    if (team.customer) {
      upsert(
        team.customer.organizationId,
        { displayName: team.customer.displayName, email: team.customer.email, phone: team.customer.phone },
        'Customer',
      );
    }
    for (const c of team.customerContacts) {
      upsert(c.businessPartnerId, c, 'Customer Contact', c.relationshipTypeName);
    }
    for (const a of team.roleAssignments) {
      upsert(
        a.party.id,
        { displayName: a.party.displayName, email: a.party.email ?? null, phone: a.party.phone ?? null },
        a.role.name,
        a.role.name,
      );
    }

    return Array.from(byId.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  })();

  // V6 — per-column sort + filter on the Team table. Sort cycles
  // none→asc→desc on header click; filter is a small input under each
  // header that does substring match (case-insensitive). Both live in
  // local component state — the dataset is small enough that
  // sort/filter happen client-side every render.
  type ColKey = 'name' | 'role' | 'kind' | 'email' | 'phone';
  const [sort, setSort] = useState<{ key: ColKey; dir: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<Record<ColKey, string>>({
    name: '', role: '', kind: '', email: '', phone: '',
  });
  const toggleSort = (key: ColKey) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null; // 3rd click clears
    });
  };
  const valueFor = (r: typeof rows[0], key: ColKey): string => {
    if (key === 'name') return r.displayName;
    if (key === 'role') return Array.from(r.roles).join(', ');
    if (key === 'kind') return Array.from(r.kinds).join(', ');
    if (key === 'email') return r.email ?? '';
    if (key === 'phone') return r.phone ?? '';
    return '';
  };
  const filtered = rows.filter((r) =>
    (Object.keys(filters) as ColKey[]).every((k) => {
      const f = filters[k].trim().toLowerCase();
      if (!f) return true;
      return valueFor(r, k).toLowerCase().includes(f);
    }),
  );
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = valueFor(a, sort.key).toLowerCase();
        const bv = valueFor(b, sort.key).toLowerCase();
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      })
    : filtered;

  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">No people on this project yet.</p>;
  }

  const SortHeader = ({ k, label }: { k: ColKey; label: string }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-100 cursor-pointer"
    >
      <span>{label}</span>
      <span className="text-slate-300 dark:text-slate-600 text-[9px] tabular-nums">
        {sort?.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  );

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-[13px]">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wider">
          <tr>
            <th className="px-4 py-2 text-left"><SortHeader k="name" label="Name" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="role" label="Role / Position" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="kind" label="Kind" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="email" label="Email" /></th>
            <th className="px-4 py-2 text-left"><SortHeader k="phone" label="Phone" /></th>
          </tr>
          {/* Filter input row — substring match against the cell's
              flattened text. Empty = pass-through. */}
          <tr className="bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
            {(['name', 'role', 'kind', 'email', 'phone'] as ColKey[]).map((k) => (
              <th key={k} className="px-3 py-1.5">
                <input
                  value={filters[k]}
                  onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))}
                  placeholder="Filter…"
                  className="w-full rounded border border-slate-200 dark:border-slate-700 px-1.5 py-1 text-[11px] focus:border-blue-400 focus:outline-none"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {sorted.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">No rows match the active filters.</td></tr>
          ) : sorted.map((r) => (
            <tr key={r.bpId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
              <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100 truncate max-w-[200px]" title={r.displayName}>
                {r.displayName}
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[220px]" title={Array.from(r.roles).join(', ')}>
                {r.roles.size > 0 ? Array.from(r.roles).join(', ') : <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-wrap gap-1">
                  {Array.from(r.kinds).map((k) => (
                    <span key={k} className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                      {k}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 truncate max-w-[220px]" title={r.email ?? ''}>
                {r.email ? (
                  <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">{r.email}</a>
                ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
              <td className="px-4 py-2 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                {r.phone ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
