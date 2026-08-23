import { useState, useEffect } from 'react';
import { Plus, Building2, Search, X, Upload, ChevronLeft, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Navigate, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { useDebounce } from '@/hooks/use-debounce';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import client from '@/api/client';
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
  createdAt: string;
  updatedAt: string;
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
  return (
    <div ref={scrollRef} className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/50 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <th className="px-4 py-2 text-left font-semibold">Organization</th>
            <th className="px-4 py-2 text-left font-semibold">Main Role</th>
            <th className="px-4 py-2 text-left font-semibold">Email</th>
            <th className="px-4 py-2 text-left font-semibold w-32">Phone</th>
            <th className="px-4 py-2 text-center font-semibold w-20">Status</th>
          </tr>
        </thead>
        <tbody>
          {partners.map((bp) => (
            <tr key={bp.id} onClick={() => onSelect(bp.id)} className="border-t border-slate-100 dark:border-slate-800 hover:bg-blue-50/30 cursor-pointer">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-700 shrink-0">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <p className="font-medium text-slate-800 dark:text-slate-100 truncate">{bp.displayName}</p>
                </div>
              </td>
              <td className="px-4 py-2.5">
                <MainRoleBadge mainRole={bp.mainRoleType} />
              </td>
              <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-[12px]">{bp.email || '—'}</td>
              <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-[12px]">{bp.phone || '—'}</td>
              <td className="px-4 py-2.5 text-center">
                <StatusBadge status={bp.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
