import { useState, useEffect, useMemo } from 'react';
import { Plus, Building2, Search, X, Upload, ChevronLeft, ChevronRight, ChevronDown, Mail, Phone } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Navigate, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import {
  ClearColumnFilters,
  ColumnFilter,
  useColumnFilters,
  type ColumnFilterConfig,
} from '@/components/shared/column-filter';
import { useDebounce } from '@/hooks/use-debounce';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { UserAvatar } from '@/components/shared/user-avatar';
import { PartnerDrawer } from './partner-drawer';
import { CreateOrganizationModal } from './create-organization-modal';
import { ImportCsvModal } from './import-csv-modal';

// Page size for the paginated organizations list. Matches the pattern
// /contacts uses (see ux/contacts) — server-driven page + meta.total so
// no rows past the old perPage=200 cap silently disappear.
const ORGS_PAGE_SIZE = 50;

type OrgsPage = {
  data: BusinessPartner[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

interface PartnerRoleSummary {
  id: number;
  isPrimary: boolean;
  roleType: { id: number; code: string; name: string };
}

export interface BusinessPartner {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  status: string;
  source: string;
  /**
   * Legacy multi-role chips — still served by the API for now but no
   * longer rendered in the BP list. Source-of-truth is mainRoleType.
   * Will be removed in M7.
   */
  roles: PartnerRoleSummary[];
  /**
   * Main Role — single primary categorization. Replaces the chips
   * column. Nullable on legacy BPs (drawer surfaces a soft prompt).
   */
  mainRoleTypeId: number | null;
  mainRoleType: { id: number; code: string; name: string; category?: string | null } | null;
  // BM2 ops-surfaces Phase A: kept only as a type-level declaration —
  // this page renders no relationships, so it doesn't read either shape.
  // The field is retained so downstream types that spread this interface
  // remain compatible until they're pruned individually.
  partnerRelationshipsA?: Array<{ id: number; partyBId: number; type: { code: string; name: string } }>;
  user: { id: number; isActive: boolean; lastLoginAt: string | null } | null;
  /**
   * QA4 CT-4 (2026-09-30) — number of DISTINCT persons whose `worker_of`
   * edge targets this org (soft-deleted persons excluded). Populated by
   * the API's `attachOrgContactCount` for every org row; undefined on
   * older responses. Zero for orgs with no workers.
   */
  contactCount?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * QA4 CT-4 (2026-09-30) — shape of GET /business-partners/:id/workers.
 * Powers the Organizations catalog's expandable nested contacts row.
 */
interface OrgWorker {
  id: number;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  role: string | null;      // BP-level main role name (e.g. "Consultant")
  titleAtB: string | null;  // per-edge title ("CFO at Acme")
}

export function PartnersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const debouncedSearch = useDebounce(search, 300);
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('partners', 'write');

  // Redirect old /partners?tab=contacts deep links to the canonical
  // /contacts surface. The Contacts tab was consolidated away in
  // ux/partner-contact — the standalone Contacts page owns the CRUD
  // for people now, this page is Organizations only.
  const redirectToContacts = searchParams.get('tab') === 'contacts';

  // Strip a stale ?tab= param (e.g. ?tab=organizations) so the URL
  // reflects the tabless UI. Runs once, idempotent.
  useEffect(() => {
    if (redirectToContacts) return;
    if (searchParams.get('tab') != null) {
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      setSearchParams(next, { replace: true });
    }
    // Mount-only sweep — the `[]` deps are intentional. searchParams
    // and setSearchParams are read but treated as stable; running this
    // on every URL change would fight with the redirect above.
  }, []);

  // Honour ?focus=<userId> deep links from elsewhere (e.g. project Team tab "Profile →"):
  // resolve the User to its BP and open the drawer.
  const focusUserId = searchParams.get('focus');
  const { data: focusedBpId } = useQuery({
    queryKey: ['user-to-bp', focusUserId],
    enabled: !!focusUserId,
    queryFn: () =>
      client.get(`/users/${focusUserId}`).then((r) => {
        const u = r.data?.data ?? r.data;
        return u?.businessPartnerId ?? null;
      }),
  });
  useEffect(() => {
    if (focusedBpId) {
      setSelectedId(focusedBpId);
      // strip focus from URL once resolved
      const next = new URLSearchParams(searchParams);
      next.delete('focus');
      setSearchParams(next, { replace: true });
    }
  }, [focusedBpId]);

  // ─── Data fetch ───────────────────────────────────────────────────────────
  // Organizations only. The Contacts tab is gone — that surface lives at
  // /contacts and has richer filters (server-side org filter, pagination,
  // By-Customer view).
  //
  // Server-side pagination (ux/polish): the previous fetch capped at
  // perPage=200 and silently dropped rows beyond it. Now driven by
  // page + meta the same way /contacts is.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [debouncedSearch]);

  const { data: orgsPage, isLoading } = useQuery<OrgsPage>({
    queryKey: ['business-partners', 'organizations', page, debouncedSearch],
    queryFn: () =>
      client
        .get('/business-partners', {
          params: {
            partnerType: 'organization',
            page,
            perPage: ORGS_PAGE_SIZE,
            search: debouncedSearch || undefined,
          },
        })
        .then((r) => {
          // Same normalisation shape /contacts uses — handles both the
          // wrapped { data: { data, meta } } envelope and older flat
          // list responses.
          const body = r.data?.data ?? r.data;
          if (Array.isArray(body)) {
            return { data: body as BusinessPartner[], meta: { total: body.length, page: 1, perPage: body.length || ORGS_PAGE_SIZE, totalPages: 1 } };
          }
          const rows = (body?.data as BusinessPartner[]) ?? [];
          const meta = body?.meta ?? { total: rows.length, page: 1, perPage: ORGS_PAGE_SIZE, totalPages: 1 };
          return { data: rows, meta };
        }),
  });

  const partners: BusinessPartner[] = orgsPage?.data ?? [];
  const meta = orgsPage?.meta;
  const totalCount = meta?.total ?? partners.length;
  const totalPages = meta?.totalPages ?? 1;

  // Redirect deep-link happens here — after all hooks — so the hook
  // count stays constant across renders (React rule of hooks).
  if (redirectToContacts) {
    return <Navigate to="/contacts" replace />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="Companies you work with — customers, suppliers, partner firms, municipalities. People contacts live under Contacts."
        actions={
          canWrite && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowImport(true)}
                className="flex items-center gap-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 px-4 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Import CSV
              </button>
              {/* Contacts / BP Excel wizard: the old BP-admin wizard
                  was retired in favour of the shared
                  /admin/data-import contacts flow so both entry points
                  drive the same 6-stage pipeline (triage, per-sheet
                  header detection, mapping presets, split & fill, dedup
                  preview, idempotent commit, project attach, history).
                  The CSV path above stays for the simpler
                  "already-formatted" case. */}
              <button
                onClick={() => navigate('/admin/data-import?target=contacts')}
                className="flex items-center gap-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 px-4 py-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Import Excel (wizard)
              </button>
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add Organization
              </button>
            </div>
          )
        }
      />

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search organizations..."
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-9 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Result count line — reads from server meta so it reflects the
          TRUE match count, not just the current page. Matches the
          /contacts page's header for consistency. */}
      {!isLoading && totalCount > 0 && (
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          Showing{' '}
          <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
            {(meta ? (meta.page - 1) * meta.perPage + 1 : 1)}
            –
            {(meta ? Math.min(meta.page * meta.perPage, totalCount) : partners.length)}
          </span>
          {' '}of{' '}
          <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">{totalCount}</span>
          {' '}organizations
        </p>
      )}

      {/* Body */}
      {isLoading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : partners.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Add the first organization you work with — customers, suppliers, partner companies."
        />
      ) : (
        <>
          <OrganizationsList partners={partners} onSelect={setSelectedId} />
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || isLoading}
                aria-label="Previous page"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Prev
              </button>
              <span className="text-[12px] text-slate-500 dark:text-slate-400">
                Page{' '}
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{page}</span>
                {' '}of{' '}
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{totalPages}</span>
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || isLoading}
                aria-label="Next page"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      )}

      {showAdd && (
        <CreateOrganizationModal
          onClose={() => setShowAdd(false)}
          onCreated={(id) => { setShowAdd(false); setSelectedId(id); }}
        />
      )}

      {showImport && <ImportCsvModal onClose={() => setShowImport(false)} />}

      {selectedId !== null && (
        <PartnerDrawer
          partnerId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ─── Per-tab list components ──────────────────────────────────────────────────

function OrganizationsList({ partners, onSelect }: { partners: BusinessPartner[]; onSelect: (id: number) => void }) {
  const scrollRef = useStickyHScroll();
  // QA3 master-handoff · Part B3 — client-side column filters over the
  // loaded page. NOTE (per spec): the endpoint is server-paginated, so
  // these filters only narrow the CURRENTLY loaded page — not all rows
  // that would match on the server. That's a known trade-off; a proper
  // server-side filter would need a separate task.
  const filterConfig = useMemo<ColumnFilterConfig<BusinessPartner>[]>(() => [
    { colKey: 'org', accessor: (r) => r.displayName ?? '', placeholder: 'Filter org…' },
    { colKey: 'mainRole', accessor: (r) => r.mainRoleType?.name ?? '', placeholder: 'Filter role…' },
    { colKey: 'email', accessor: (r) => r.email ?? '', placeholder: 'Filter email…' },
    { colKey: 'phone', accessor: (r) => r.phone ?? '', placeholder: 'Filter phone…' },
    { colKey: 'status', accessor: (r) => r.status ?? '', options: [
      { value: 'active', label: 'active' }, { value: 'inactive', label: 'inactive' },
      { value: 'lead', label: 'lead' }, { value: 'archived', label: 'archived' },
    ]},
  ], []);
  const { filters, set, clear, activeCount, filtered: filteredPartners } =
    useColumnFilters(partners, filterConfig);
  // QA4 CT-4 (2026-09-30) — expandable nested contacts per org. Track
  // which org rows are open so the chevron can rotate + the nested
  // <tr> render. Toggle is per-row and does NOT open the drawer — a
  // click on the chevron area toggles, a click anywhere else on the
  // row opens the drawer.
  const [expandedOrgIds, setExpandedOrgIds] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) => {
    setExpandedOrgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div>
      <ClearColumnFilters activeCount={activeCount} onClear={clear} />
      <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[#FAFBFC] dark:bg-slate-800/80 text-[11px] uppercase tracking-[0.05em] text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
            <th className="w-8 px-2 py-2" aria-label="Expand" />
            <th className="px-4 py-2 text-left font-semibold">Organization</th>
            <th className="px-4 py-2 text-left font-semibold">Type</th>
            <th className="px-4 py-2 text-left font-semibold">Email</th>
            <th className="px-4 py-2 text-left font-semibold w-32">Phone</th>
            <th className="px-4 py-2 text-right font-semibold w-24">Contacts</th>
            <th className="px-4 py-2 text-center font-semibold w-20">Status</th>
          </tr>
          <tr className="border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/60">
            <th className="px-2 py-1.5" />
            <th className="px-2 py-1.5"><ColumnFilter config={filterConfig[0]} value={filters.org ?? ''} onChange={(v) => set('org', v)} label="Organization" /></th>
            <th className="px-2 py-1.5"><ColumnFilter config={filterConfig[1]} value={filters.mainRole ?? ''} onChange={(v) => set('mainRole', v)} label="Type" /></th>
            <th className="px-2 py-1.5"><ColumnFilter config={filterConfig[2]} value={filters.email ?? ''} onChange={(v) => set('email', v)} label="Email" /></th>
            <th className="px-2 py-1.5"><ColumnFilter config={filterConfig[3]} value={filters.phone ?? ''} onChange={(v) => set('phone', v)} label="Phone" /></th>
            <th className="px-2 py-1.5" />
            <th className="px-2 py-1.5"><ColumnFilter config={filterConfig[4]} value={filters.status ?? ''} onChange={(v) => set('status', v)} label="Status" /></th>
          </tr>
        </thead>
        <tbody>
          {filteredPartners.map((bp) => {
            const isExpanded = expandedOrgIds.has(bp.id);
            const contactCount = bp.contactCount ?? 0;
            return (
              <OrgRowWithContacts
                key={bp.id}
                partner={bp}
                isExpanded={isExpanded}
                onToggle={() => toggleExpanded(bp.id)}
                onSelect={onSelect}
                contactCount={contactCount}
              />
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/**
 * QA4 CT-4 (2026-09-30) — one organization row + (when expanded) a
 * nested list of the people whose `worker_of` edge points at this org.
 *
 * The parent org row stays clickable to open the drawer; the chevron
 * cell is its own click target so expand/collapse doesn't fight the
 * open-drawer intent. The worker list is fetched lazily on first
 * expand via `GET /business-partners/:id/workers` — the query is
 * enabled only when `isExpanded` is true, so an unexpanded row costs
 * nothing beyond the count badge that ships with the parent response.
 */
function OrgRowWithContacts({
  partner: bp,
  isExpanded,
  onToggle,
  onSelect,
  contactCount,
}: {
  partner: BusinessPartner;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: (id: number) => void;
  contactCount: number;
}) {
  const { data: workers, isLoading: workersLoading } = useQuery<OrgWorker[]>({
    // Keyed on the org id so an edit that invalidates ['business-partners']
    // also invalidates this per-org list.
    queryKey: ['business-partners', bp.id, 'workers'],
    enabled: isExpanded,
    queryFn: () =>
      client.get(`/business-partners/${bp.id}/workers`).then((r) => {
        const body = r.data?.data ?? r.data;
        if (Array.isArray(body)) return body as OrgWorker[];
        const rows = (body?.data as OrgWorker[]) ?? [];
        return rows;
      }),
    staleTime: 60_000,
  });
  return (
    <>
      <tr
        onClick={() => onSelect(bp.id)}
        className="border-t border-slate-100 dark:border-slate-800 hover:bg-blue-50/30 dark:hover:bg-blue-900/20 cursor-pointer"
      >
        {/* Chevron cell — stopPropagation so the drawer doesn't open
            when the user just wants to see the contacts. */}
        <td className="w-8 px-2 py-2.5 text-center align-middle">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse contacts for ${bp.displayName}` : `Expand contacts for ${bp.displayName}`}
            className="inline-flex items-center justify-center rounded-md p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300 focus:outline-none focus:border-blue-500"
            disabled={contactCount === 0}
            title={contactCount === 0 ? 'No contacts at this organization' : (isExpanded ? 'Collapse' : 'Expand')}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 shrink-0">
              <Building2 className="h-4 w-4" />
            </div>
            <p className="font-medium text-slate-800 dark:text-slate-100 truncate">{bp.displayName}</p>
          </div>
        </td>
        <td className="px-4 py-2.5">
          <MainRoleBadge mainRole={bp.mainRoleType} />
        </td>
        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-[12px]">{bp.email || '—'}</td>
        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-[12px] font-mono tabular-nums">{bp.phone || '—'}</td>
        <td className="px-4 py-2.5 text-right">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide',
              contactCount > 0
                ? 'bg-violet-600/10 text-violet-700 dark:text-violet-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500',
            )}
            title={contactCount === 1 ? '1 contact' : `${contactCount} contacts`}
          >
            {contactCount}
          </span>
        </td>
        <td className="px-4 py-2.5 text-center">
          <StatusBadge status={bp.status} />
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-slate-50/60 dark:bg-slate-800/40">
          <td colSpan={7} className="px-0 py-0 border-t border-slate-100 dark:border-slate-800">
            {/* Nested contact list — same visual density as the By
                Organization group's tbody rows on /contacts. Rendered
                as a small inner table so column alignment stays crisp
                without cramming into the parent's cells. */}
            <div className="px-10 py-2">
              {workersLoading ? (
                <p className="text-[12px] italic text-slate-400 dark:text-slate-500 py-2">Loading contacts…</p>
              ) : (workers ?? []).length === 0 ? (
                <p className="text-[12px] italic text-slate-400 dark:text-slate-500 py-2">
                  No contacts at this organization yet.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">
                      <th className="text-left px-2 py-1.5 font-semibold">Name</th>
                      <th className="text-left px-2 py-1.5 font-semibold">Role</th>
                      <th className="text-left px-2 py-1.5 font-semibold">Email</th>
                      <th className="text-left px-2 py-1.5 font-semibold w-40">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(workers ?? []).map((w) => {
                      const phone = w.phone || w.mobile || '';
                      const roleLabel = w.titleAtB || w.role || '';
                      return (
                        <tr
                          key={w.id}
                          onClick={() => onSelect(w.id)}
                          className="cursor-pointer hover:bg-white dark:hover:bg-slate-900 border-t border-slate-100 dark:border-slate-800"
                        >
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <UserAvatar
                                firstName={w.firstName ?? ''}
                                lastName={w.lastName ?? ''}
                                avatarUrl={null}
                                size="sm"
                              />
                              <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate" title={w.displayName}>
                                {w.displayName}
                              </p>
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-[13px] text-slate-700 dark:text-slate-200">
                            {roleLabel || <span className="italic text-slate-400 dark:text-slate-500">—</span>}
                          </td>
                          <td className="px-2 py-1.5 text-[13px]">
                            {w.email ? (
                              <a
                                href={`mailto:${w.email}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700 truncate max-w-full"
                                title={w.email}
                              >
                                <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                                <span className="truncate">{w.email}</span>
                              </a>
                            ) : (
                              <span className="text-slate-300 dark:text-slate-600 italic">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-[13px]">
                            {phone ? (
                              <a
                                href={`tel:${phone}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700"
                              >
                                <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                                <span className="tabular-nums font-mono">{phone}</span>
                              </a>
                            ) : (
                              <span className="text-slate-300 dark:text-slate-600 italic">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Tiny helpers ────────────────────────────────────────────────────────────

/**
 * Renders the BP's Main Role as a single colored badge. Replaces the
 * legacy multi-role chips column. When unset, shows a muted "not set"
 * label so admins notice and can fix via the drawer's soft prompt.
 */
function MainRoleBadge({
  mainRole,
}: {
  mainRole: BusinessPartner['mainRoleType'];
}) {
  if (!mainRole) {
    return (
      <span className="text-[11px] text-slate-400 dark:text-slate-500 italic">not set</span>
    );
  }
  return (
    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
      {mainRole.name}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === 'active';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize',
      isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', isActive ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-500')} />
      {status}
    </span>
  );
}
