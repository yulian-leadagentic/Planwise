import { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, X, Mail, Phone, Building2, FolderKanban, Pencil, UserPlus, Upload,
  List as ListIcon, FolderOpen, Building, ExternalLink, MapPin, UserCircle2,
  ChevronLeft, ChevronRight, ChevronDown, User as UserIcon, Plus, ArrowRight,
} from 'lucide-react';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { usePermissions } from '@/hooks/use-permissions';
import { UserAvatar } from '@/components/shared/user-avatar';
import { PartnerDrawer } from './partner-drawer';
import { CreatePartnerModal } from './create-partner-modal';

/**
 * Dedicated Contacts page — its own route (/contacts), not a tab inside the
 * Partners surface. Hosts three view modes (List, By Project, By Customer)
 * and pulls project-enrichment data from /business-partners?withProjects=true
 * so each contact carries their project list + active/archived counts.
 *
 * Excludes "internal employees" by identity (anyone whose BP row carries a
 * `user` — a login account ≡ internal staff). External contacts only.
 */

type ContactProject = {
  id: number;
  name: string;
  number: string | null;
  status: string;
  role: string | null;
  via: 'direct' | 'employer';
};

type Contact = {
  id: number;
  partnerType: 'person' | 'organization';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  address: string | null;
  linkedinUrl: string | null;
  status: string;
  mainRoleType: { id: number; code: string; name: string } | null;
  // BM2 ops-surfaces Phase A: shape from the new-shape include on the
  // /business-partners response. `partnerRelationshipsA` = party↔party
  // rows where THIS contact is party A (their worker_of employer lives here).
  partnerRelationshipsA: Array<{
    id: number;
    partyBId: number;
    type: { code: string; name: string } | null;
    validTo?: string | null;
    status?: string;
  }>;
  user: { id: number; isActive: boolean } | null;
  projectCount: { active: number; archived: number };
  projects: ContactProject[];
};

type Org = {
  id: number;
  displayName: string;
  companyName: string | null;
  // The seeded "Internal" org represents your own company. Anyone with
  // a worker_of edge pointing at it is internal staff (see
  // internalOrgIds below). Kept optional so older responses without
  // this field still parse.
};

// QA3 Commit D (Item 6d) — shape returned by GET /projects/attached-contacts.
type AttachedProject = {
  projectId: number;
  projectName: string;
  projectNumber: string | null;
  projectStatus: string;
  contacts: Array<{
    id: number;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    partnerType: 'person' | 'organization';
    roleCode: string;
    roleName: string;
    titleInProject: string | null;
    orgId: number | null;
    orgName: string | null;
    isInternal: boolean;
  }>;
};

type ViewMode = 'list' | 'by-project' | 'by-customer';

const VIEW_TABS: Array<{ key: ViewMode; label: string; icon: React.ComponentType<{ className?: string }>; sub: string }> = [
  { key: 'list',        label: 'List',        icon: ListIcon, sub: 'Every contact in one table' },
  { key: 'by-project',  label: 'By Project',  icon: FolderOpen, sub: 'Contacts grouped per project' },
  { key: 'by-customer', label: 'By Customer', icon: Building, sub: 'Contacts grouped per customer org' },
];

// Contacts endpoint returns { data: Contact[], meta: { total, page, ... } }
// under two wrapper layers (axios envelope + API success wrapper). The
// query normalises to this shape so consumers stop guessing.
type ContactsPage = {
  data: Contact[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

const LIST_PAGE_SIZE = 50;
// For grouping views (By Customer / By Project) we bump the page size
// so the per-group counts reflect the true set — the previous 200-row
// cap was hiding contacts whose employer sat past the boundary. 500 is
// the ceiling here; if a tenant grows past it we'll switch grouping
// views to a dedicated aggregation endpoint (out of scope for this fix).
const GROUP_PAGE_SIZE = 500;

export function ContactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Gate the "Import contacts" action: admin OR write on
  // `data-import/contacts` (backend enforces the same at
  // contacts-import.controller.ts:64, module seeded in
  // migration 20260520000000_data_import_module). Reuse the existing deep
  // link — `?target=contacts` opens the same wizard component with the
  // contacts branch already selected (data-import-page.tsx:82-93) — so
  // we never duplicate the wizard here.
  const { can, isAdmin } = usePermissions();
  const canImportContacts = isAdmin || can('data-import/contacts', 'write');
  const initialView = (searchParams.get('view') as ViewMode) ?? 'list';
  const [view, setView] = useState<ViewMode>(
    VIEW_TABS.some((t) => t.key === initialView) ? initialView : 'list',
  );
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  // orgFilter drives a SERVER-side employerId param now — the previous
  // client-side .filter() over the loaded page silently hid employees
  // of that org whose row sat past row 200.
  const [orgFilter, setOrgFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  // Drawer identity in the URL (?contact=N) so refresh / outbound-return
  // restore it, matching the task-drawer's useDrawerRoute('task') pattern.
  const { drawerId: selectedId, openDrawer: openContact, closeDrawer: closeContact } = useDrawerRoute('contact');

  const perPage = view === 'list' ? LIST_PAGE_SIZE : GROUP_PAGE_SIZE;

  // Unified "New" split-button — offers "New Contact" and "New
  // Organization", opening the shared CreatePartnerModal with the
  // right default type. Consolidation from ux/partner-contact — the
  // separate contact/organization creation flows now render the
  // same form under the hood (see create-partner-modal.tsx).
  const [showCreate, setShowCreate] = useState<null | 'person' | 'organization'>(null);
  // QA3 Commit D (Item 6a) — "Add contact" for a specific customer org.
  // When set, the CreatePartnerModal opens in person mode with the
  // employer preset + locked, so the flow explicitly reads "add a
  // contact at THIS customer" (matches the existing project Team
  // customer-contact adder convention).
  const [addContactForOrgId, setAddContactForOrgId] = useState<number | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [newMenuOpen]);

  // Any filter change resets pagination to page 1 — otherwise a user on
  // page 3 who narrows the search would either see empty results (if the
  // filtered set has fewer pages) or land on an unrelated slice.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, orgFilter, view]);

  // Sync view to URL so deep-links/back button work.
  const switchView = (v: ViewMode) => {
    setView(v);
    const next = new URLSearchParams(searchParams);
    next.set('view', v);
    setSearchParams(next, { replace: true });
  };

  // Contacts (persons with project enrichment). Returns the full page
  // envelope: rows + server-side meta (total, page count, …) so the
  // header can show truthful totals and pagination controls have data.
  const { data: contactsPage, isLoading: contactsLoading } = useQuery<ContactsPage>({
    // Prefix with 'business-partners' so the partner drawer's save mutations
    // (which invalidate ['business-partners']) cascade down to this query and
    // the list refreshes after an edit, without manual reload.
    queryKey: ['business-partners', 'contacts-list', view, page, perPage, debouncedSearch, statusFilter, orgFilter],
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: 'person',
          withProjects: true,
          page: view === 'list' ? page : 1,
          perPage,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter === 'active' ? 'active' : 'inactive' } : {}),
          ...(orgFilter ? { employerId: Number(orgFilter) } : {}),
        },
      }).then((r) => {
        // Handle both wrapper layers — the API wraps { data: { data, meta } }
        // and axios adds its own .data. Fall back to a plain array shape
        // for older callers.
        const body = r.data?.data ?? r.data;
        if (Array.isArray(body)) {
          return { data: body as Contact[], meta: { total: body.length, page: 1, perPage: body.length || perPage, totalPages: 1 } };
        }
        const rows = (body?.data as Contact[]) ?? [];
        const meta = body?.meta ?? { total: rows.length, page: 1, perPage, totalPages: 1 };
        return { data: rows, meta };
      }),
    staleTime: 60_000,
  });

  // Organizations — used for the employer lookup + the By Customer view.
  const { data: orgsData } = useQuery<Org[]>({
    queryKey: ['business-partners', 'orgs-for-contacts'],
    queryFn: () =>
      client.get('/business-partners', { params: { partnerType: 'organization', perPage: 200 } })
        .then((r) => {
          const body = r.data?.data ?? r.data;
          return Array.isArray(body) ? body : (body?.data ?? []);
        }),
    staleTime: 5 * 60_000,
  });

  // Customer organizations — drives the By Customer view.
  //
  // QA3 Commit D (Item 6b, 2026-09-01) — `includeProjectCustomers=true`
  // makes the API union orgs holding the `customer` role-tag with orgs
  // that appear as `customer` on any active ProjectPartnerRole. Before
  // this, orgs used as project customers whose partner-role tag was
  // never set (legacy data from before the create-project auto-tag
  // guard — e.g. אסדן / טקרו / חדיף on staging) were invisible here.
  // The write path now auto-upserts the tag (see projects.service
  // + project-partner-roles.service), so the UNION is a safety net for
  // pre-existing rows rather than the primary source of truth.
  const { data: customersData } = useQuery<Org[]>({
    queryKey: ['business-partners', 'customers-for-contacts', 'v2-union'],
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: 'organization',
          roleType: 'customer',
          includeProjectCustomers: true,
          perPage: 200,
        },
      }).then((r) => {
        const body = r.data?.data ?? r.data;
        return Array.isArray(body) ? body : (body?.data ?? []);
      }),
    staleTime: 5 * 60_000,
  });

  // QA3 Commit D (Item 6d, 2026-09-01) — By-Project feed. Loads only
  // when the By Project view is active so the initial page render
  // (default view = list) stays cheap.
  const { data: attachedByProject, isLoading: byProjectLoading } = useQuery<AttachedProject[]>({
    queryKey: ['projects', 'attached-contacts'],
    enabled: view === 'by-project',
    queryFn: () =>
      client.get('/projects/attached-contacts').then((r) => {
        const body = r.data?.data ?? r.data;
        return Array.isArray(body) ? body : (body?.data ?? []);
      }),
    staleTime: 60_000,
  });

  const allContacts: Contact[] = contactsPage?.data ?? [];
  const meta = contactsPage?.meta;
  const orgs: Org[] = orgsData ?? [];
  const orgNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of orgs) m.set(o.id, o.displayName);
    return m;
  }, [orgs]);

  // Ported from the old Partners "Contacts" tab (parity requirement in
  // ux/partner-contact): the seeded "Internal" org represents your own
  // company, and anyone worker_of it is internal staff even if they
  // don't have a login account yet. Primary rule below still catches
  // the login case; this is the secondary safety net.
  const internalOrgIds = useMemo(() => {
    const ids = new Set<number>();
    for (const o of orgs) {
      const isInternal = (o.companyName ?? '').toLowerCase() === 'internal'
        || (o.displayName ?? '').toLowerCase() === 'internal';
      if (isInternal) ids.add(o.id);
    }
    return ids;
  }, [orgs]);

  // Identity rule — anyone with a login account is INTERNAL staff, belongs
  // in /people not Contacts.
  //
  // NB: this filter runs on the loaded page only, so a page that happens
  // to be all-internal would render as empty when a further page has
  // externals. Acceptable because internal accounts on the /contacts
  // surface are already the exception (most persons here are external);
  // the server-side partnerType='person' + the filters below narrow the
  // set enough that this is not a routine concern.
  const externalContacts = useMemo(
    () => allContacts.filter((c) => {
      // Primary — has a login account → internal.
      if (c.user) return false;
      // Secondary — explicitly working for the Internal org.
      if (internalOrgIds.size > 0) {
        const workerOf = c.partnerRelationshipsA?.find(
          (r) => r.type?.code === 'worker_of',
        );
        if (workerOf && internalOrgIds.has(workerOf.partyBId)) return false;
      }
      return true;
    }),
    [allContacts, internalOrgIds],
  );

  // Employer dropdown — sourced from the full org roster (already loaded
  // above) instead of derived from the current page. Previously this was
  // built from externalContacts, so paginating away from page 1 dropped
  // employers whose only contact sat on that page. Any org can be picked;
  // if it has zero contacts under the current filters the server returns
  // an empty page and the empty-state kicks in.
  const employerOrgs = useMemo(
    () => [...orgs].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [orgs],
  );

  // Rows to render this page. Server-side employerId + status + search
  // narrowed the set already — no client-side org filter here anymore.
  const visibleContacts = externalContacts;

  const hasFilters = !!search || statusFilter !== 'active' || !!orgFilter;

  // Header count string — server total when available so the badge is
  // truthful even when the current page holds only a slice. Falls back
  // to the local count for the initial render before meta lands.
  const totalCount = meta?.total ?? externalContacts.length;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Contacts</h1>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
            People at customers and partners — searchable, filterable, and grouped by project or customer.
          </p>
        </div>
        <div className="flex items-center gap-2">
        {/* "Import contacts" — routes to the existing wizard via the
            deep-link that data-import-page.tsx already supports
            (?target=contacts auto-selects the contacts branch and jumps
            past step 1). The wizard component is not duplicated. Gated
            by admin OR data-import/contacts:write; the backend re-checks
            the same guard at contacts-import.controller.ts:64. */}
        {canImportContacts && (
          <button
            type="button"
            onClick={() => navigate('/admin/data-import?target=contacts')}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:border-slate-400 dark:hover:border-slate-500"
            title="Bulk-import contacts from an Excel or CSV file"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Import contacts
          </button>
        )}
        {/* Split-button "New" — the single creation entry point since
            ux/partner-contact. Opens the shared CreatePartnerModal
            with either 'person' or 'organization' as the starting
            mode; the user can still flip the toggle inside the modal
            if they picked the wrong option. */}
        <div ref={newMenuRef} className="relative">
          <div className="inline-flex rounded-md shadow-sm">
            <button
              type="button"
              onClick={() => { setShowCreate('person'); setNewMenuOpen(false); }}
              className="inline-flex items-center gap-2 rounded-l-md bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" /> New Contact
            </button>
            <button
              type="button"
              onClick={() => setNewMenuOpen((v) => !v)}
              aria-label="More create options"
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              className="rounded-r-md border-l border-blue-500/40 bg-blue-600 hover:bg-blue-700 px-2 py-2 text-white"
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {newMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-56 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg overflow-hidden z-20"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => { setShowCreate('person'); setNewMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <UserIcon className="h-4 w-4 text-blue-600" aria-hidden="true" />
                New Contact
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setShowCreate('organization'); setNewMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Building2 className="h-4 w-4 text-violet-600" aria-hidden="true" />
                New Organization
              </button>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Filter strip */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, phone…"
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
          {search && (
            <button onClick={() => setSearch('')} title="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
          title="Filter by status"
        >
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
          <option value="all">All statuses</option>
        </select>
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm max-w-[220px]"
          title="Filter by employer organization"
        >
          <option value="">All organizations</option>
          {employerOrgs.map((o) => (
            <option key={o.id} value={o.id}>{o.displayName}</option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setStatusFilter('active'); setOrgFilter(''); }}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[12px] text-slate-500 dark:text-slate-400">
          {view === 'list' && totalCount > 0 ? (
            <>
              Showing{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
                {(meta ? (meta.page - 1) * meta.perPage + 1 : 1)}
                –
                {(meta ? Math.min(meta.page * meta.perPage, totalCount) : visibleContacts.length)}
              </span>
              {' '}of{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{totalCount}</span>
              {' '}contacts
            </>
          ) : (
            <>
              <span className="font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{totalCount}</span>
              {' '}contact{totalCount === 1 ? '' : 's'}
              {totalCount > perPage && (
                <span className="ml-1 text-[11px] italic text-amber-600 dark:text-amber-400" title={`Grouping views show up to ${perPage} contacts at a time`}>
                  (showing first {perPage})
                </span>
              )}
            </>
          )}
        </span>
      </div>

      {/* View toggle */}
      <div className="border-b border-slate-200 dark:border-slate-700">
        <div className="flex gap-1.5 flex-nowrap overflow-x-auto">
          {VIEW_TABS.map((t) => {
            const Icon = t.icon;
            const active = view === t.key;
            return (
              <button
                key={t.key}
                onClick={() => switchView(t.key)}
                className={cn(
                  '-mb-px rounded-t-lg border border-b-2 px-4 py-2.5 text-sm font-bold transition-colors shrink-0 whitespace-nowrap inline-flex items-center gap-2',
                  active
                    ? 'border-slate-200 dark:border-slate-700 border-b-blue-600 bg-blue-50 text-blue-700'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100',
                )}
              >
                <Icon className="h-4 w-4" />
                {t.label}
                <span className={cn('ml-1 text-[11px] font-medium', active ? 'text-blue-500' : 'text-slate-400 dark:text-slate-500')}>
                  {t.sub}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* View body */}
      {contactsLoading ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading contacts…</div>
      ) : visibleContacts.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500 italic">
          {externalContacts.length === 0
            ? 'No external contacts yet. Add one from Partners → Add Contact, or click "New Contact" above.'
            : 'No contacts match the current filters.'}
        </div>
      ) : view === 'list' ? (
        <>
          <ContactsListView contacts={visibleContacts} orgNameById={orgNameById} onSelect={openContact} />
          {/* Pagination — visible in list view whenever more than one
              page exists. Prev/Next are keyboard-focusable with aria
              labels; the page indicator uses tabular-nums so the width
              doesn't jitter as the counter advances. */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || contactsLoading}
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
                disabled={page >= totalPages || contactsLoading}
                aria-label="Next page"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-50"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      ) : view === 'by-project' ? (
        <ByProjectView
          groups={attachedByProject ?? []}
          isLoading={byProjectLoading}
          onSelectContact={openContact}
          onOpenProject={(id) => navigate(`/projects/${id}`)}
        />
      ) : (
        <ByCustomerView
          customers={customersData ?? []}
          contacts={visibleContacts}
          onSelect={openContact}
          onAddContact={(orgId) => setAddContactForOrgId(orgId)}
          onOpenCustomer={openContact}
        />
      )}

      {/* Drawer for editing a contact (reuses the partner drawer). Now
          driven by the URL via useDrawerRoute('contact'), so a refresh
          or an outbound → back navigation restores the open contact. */}
      {selectedId !== null && (
        <PartnerDrawer
          partnerId={selectedId}
          onClose={closeContact}
        />
      )}

      {/* Shared creation modal — opens the newly-created record in the
          drawer via useDrawerRoute so the URL reflects the state. */}
      {showCreate !== null && (
        <CreatePartnerModal
          defaultPartnerType={showCreate}
          onClose={() => setShowCreate(null)}
          onCreated={(id) => { setShowCreate(null); openContact(id); }}
        />
      )}

      {/* QA3 Commit D (Item 6a) — "Add contact at <customer>" flow.
          Locks the form to person mode with the employer pre-selected
          and pinned to that customer. Same modal component as the free
          "New Contact" above so the surface stays consistent. */}
      {addContactForOrgId !== null && (
        <CreatePartnerModal
          defaultPartnerType="person"
          lockPartnerType
          preselectEmployerOrgId={addContactForOrgId}
          lockEmployer
          onClose={() => setAddContactForOrgId(null)}
          onCreated={(id) => { setAddContactForOrgId(null); openContact(id); }}
        />
      )}
    </div>
  );
}

/* ─── List view ─────────────────────────────────────────────────────────── */

function ContactsListView({
  contacts, orgNameById, onSelect,
}: {
  contacts: Contact[];
  orgNameById: Map<number, string>;
  onSelect: (id: number) => void;
}) {
  // Each row carries: avatar, name + role/employer subline, email + phone
  // (clickable), employer chip, project chips (top N + "+N more"), project
  // count badge, status, quick actions (edit, mail, call, linkedin).
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
      {contacts.map((c) => {
        const workerOf = (c.partnerRelationshipsA ?? []).find(
          (r) => r.type?.code === 'worker_of',
        );
        const employerName = workerOf
          ? (orgNameById.get(workerOf.partyBId) ?? `Organization #${workerOf.partyBId}`)
          : (c.companyName ?? null);
        const phone = c.phone || c.mobile || '';

        return (
          <div
            key={c.id}
            onClick={() => onSelect(c.id)}
            className="group flex flex-col xl:flex-row xl:items-center gap-3 xl:gap-4 px-4 py-3.5 hover:bg-blue-50/40 cursor-pointer transition-colors"
          >
            {/* Identity */}
            <div className="flex items-center gap-3 min-w-0 xl:w-[260px] xl:shrink-0">
              <UserAvatar
                firstName={c.firstName ?? ''} lastName={c.lastName ?? ''}
                avatarUrl={null} size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-[14px] text-slate-800 dark:text-slate-100 truncate">{c.displayName}</p>
                <p className="text-[12px] text-slate-500 dark:text-slate-400 truncate">
                  {c.mainRoleType?.name ?? <span className="italic text-slate-400 dark:text-slate-500">no role</span>}
                  {employerName ? <> · <span className="text-slate-600 dark:text-slate-300">{employerName}</span></> : null}
                </p>
              </div>
            </div>

            {/* Contact info */}
            <div className="flex flex-col gap-0.5 text-[12px] min-w-0 xl:w-[260px] xl:shrink-0">
              {c.email ? (
                <a
                  href={`mailto:${c.email}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700 truncate"
                  title={c.email}
                >
                  <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="truncate">{c.email}</span>
                </a>
              ) : <span className="inline-flex items-center gap-1.5 text-slate-300 dark:text-slate-600"><Mail className="h-3.5 w-3.5" /> —</span>}
              {phone ? (
                <a
                  href={`tel:${phone}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700"
                >
                  <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="tabular-nums">{phone}</span>
                </a>
              ) : <span className="inline-flex items-center gap-1.5 text-slate-300 dark:text-slate-600"><Phone className="h-3.5 w-3.5" /> —</span>}
            </div>

            {/* Employer chip + address */}
            <div className="hidden xl:flex flex-col gap-0.5 text-[12px] min-w-0 w-[200px] shrink-0">
              {employerName && (
                <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 truncate">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="truncate" title={employerName}>{employerName}</span>
                </span>
              )}
              {c.address && (
                <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 truncate" title={c.address}>
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="truncate">{c.address}</span>
                </span>
              )}
            </div>

            {/* Flexible spacer — pushes the count badge to the right edge
                while leaving the row's middle area uncluttered. We used
                to render per-project chips here, but they truncated to
                bare folder icons on laptop widths and visually stacked
                under the "X active" badge, looking like duplicate empty
                shapes. The count badge already conveys "how many" at a
                glance; full project lists belong on the contact's
                drawer/detail view. (T2.fix7, 2026-06-30.) */}
            <div className="flex-1 min-w-0" />

            {/* Project count badge */}
            <div className="flex items-center gap-1.5 shrink-0 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-emerald-700 font-semibold tabular-nums" title="Active projects">
                <FolderKanban className="h-3 w-3" />
                {c.projectCount.active} active
              </span>
              {c.projectCount.archived > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-slate-500 dark:text-slate-400 font-medium tabular-nums" title="Archived / inactive projects">
                  {c.projectCount.archived} archived
                </span>
              )}
            </div>

            {/* Status */}
            <div className="shrink-0">
              <ContactStatusBadge status={c.status} />
            </div>

            {/* Quick actions */}
            <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {c.email && (
                <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}
                   className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title={`Email ${c.displayName}`}>
                  <Mail className="h-3.5 w-3.5" />
                </a>
              )}
              {phone && (
                <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()}
                   className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title={`Call ${c.displayName}`}>
                  <Phone className="h-3.5 w-3.5" />
                </a>
              )}
              {c.linkedinUrl && (
                <a href={c.linkedinUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                   className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title="Open LinkedIn">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button onClick={(e) => { e.stopPropagation(); onSelect(c.id); }}
                      className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title="Edit contact">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ContactStatusBadge({ status }: { status: string }) {
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

/* ─── By Customer view ──────────────────────────────────────────────────── */

/**
 * Grid of cards — one per customer organization, listing the contacts that
 * work_of that org. Cards are sorted by contact count (most populated first)
 * so the most actionable customers surface at the top. Customers with zero
 * known contacts still render so the user sees the full customer roster +
 * a clear empty hint to add the first contact.
 */
function ByCustomerView({
  customers, contacts, onSelect, onAddContact, onOpenCustomer,
}: {
  customers: Org[];
  contacts: Contact[];
  onSelect: (id: number) => void;
  // QA3 Commit D (Item 6a) — parent-owned "Add contact for this customer"
  // trigger; opens the shared Person New-Contact modal with the employer
  // pre-selected & locked.
  onAddContact: (customerOrgId: number) => void;
  // QA3 Commit D (Item 6c) — parent-owned "open the customer's BP drawer"
  // trigger. Reuses the same useDrawerRoute('contact') channel as the
  // per-contact rows so refresh / back restore the open state.
  onOpenCustomer: (customerOrgId: number) => void;
}) {
  // Group contacts by their worker_of org id.
  const byOrg = useMemo(() => {
    const m = new Map<number, Contact[]>();
    for (const c of contacts) {
      for (const r of c.partnerRelationshipsA ?? []) {
        if (r.type?.code === 'worker_of') {
          const arr = m.get(r.partyBId) ?? [];
          if (!arr.some((x) => x.id === c.id)) arr.push(c);
          m.set(r.partyBId, arr);
        }
      }
    }
    return m;
  }, [contacts]);

  // Contacts whose employer org is NOT in the customer list — bucketed below
  // the customer cards so they aren't invisible (e.g. supplier contacts, or
  // contacts whose employer hasn't been tagged customer yet).
  const customerIds = new Set(customers.map((c) => c.id));
  const orphanContacts = contacts.filter((c) => {
    const workerOf = (c.partnerRelationshipsA ?? []).find(
      (r) => r.type?.code === 'worker_of',
    );
    if (!workerOf) return true; // contact with no employer
    return !customerIds.has(workerOf.partyBId); // employer isn't a customer
  });

  const sortedCustomers = [...customers].sort((a, b) => {
    const ca = byOrg.get(a.id)?.length ?? 0;
    const cb = byOrg.get(b.id)?.length ?? 0;
    if (ca !== cb) return cb - ca; // most contacts first
    return a.displayName.localeCompare(b.displayName);
  });

  if (customers.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
        <Building className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600 mb-3" />
        <p className="font-semibold text-slate-700 dark:text-slate-200">No customer organizations yet</p>
        <p className="mt-1 text-[12px] text-slate-400 dark:text-slate-500">
          Any organization set as a project's customer, or tagged with the{' '}
          <span className="font-mono text-slate-500 dark:text-slate-400">customer</span> role, will appear here.
          Add one from <span className="font-mono text-slate-500 dark:text-slate-400">Partners → Organizations</span> to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sortedCustomers.map((customer) => (
          <CustomerCard
            key={customer.id}
            customer={customer}
            contacts={byOrg.get(customer.id) ?? []}
            onSelect={onSelect}
            onAddContact={onAddContact}
            onOpenCustomer={onOpenCustomer}
          />
        ))}
      </div>

      {orphanContacts.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <UserCircle2 className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">Other contacts</h3>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              ({orphanContacts.length} not linked to a customer)
            </span>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-700">
            {orphanContacts.map((c) => (
              <CompactContactRow key={c.id} contact={c} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerCard({
  customer, contacts, onSelect, onAddContact, onOpenCustomer,
}: {
  customer: Org;
  contacts: Contact[];
  onSelect: (id: number) => void;
  onAddContact: (customerOrgId: number) => void;
  onOpenCustomer: (customerOrgId: number) => void;
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header
          QA3 Commit D (Item 6c) — the entire header is now a clickable
          button that opens the org's partner drawer (`?contact=<id>`);
          the Add-contact action inside stops propagation so it opens the
          create modal instead of the drawer. Per-contact rows below
          keep their own click handler with their own stopPropagation. */}
      <div className="border-b border-slate-100 dark:border-slate-800 bg-gradient-to-br from-purple-50 to-white dark:from-purple-950/30 dark:to-slate-900">
        <div className="flex items-stretch">
          <button
            type="button"
            onClick={() => onOpenCustomer(customer.id)}
            className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3 text-left hover:bg-purple-50/60 dark:hover:bg-purple-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-l-[14px]"
            title={`Open ${customer.displayName}`}
          >
            <div className="rounded-lg bg-purple-100 dark:bg-purple-900/50 p-2 shrink-0">
              <Building2 className="h-5 w-5 text-purple-700 dark:text-purple-300" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-[14px] text-slate-800 dark:text-slate-100 truncate" title={customer.displayName}>
                {customer.displayName}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/50 px-1.5 py-0.5 font-semibold text-purple-700 dark:text-purple-300">
                  Customer
                </span>
                <span className="ml-2 tabular-nums">
                  {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
                </span>
              </p>
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAddContact(customer.id); }}
            className="shrink-0 px-3 flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-l border-slate-200 dark:border-slate-700 rounded-r-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title={`Add a contact at ${customer.displayName}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add contact
          </button>
        </div>
      </div>

      {/* Contact list */}
      {contacts.length === 0 ? (
        <button
          type="button"
          onClick={() => onAddContact(customer.id)}
          className="w-full px-4 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic hover:bg-blue-50/40 dark:hover:bg-blue-900/20 hover:text-blue-700 dark:hover:text-blue-300"
        >
          No contacts at this customer yet. Click to add the first.
        </button>
      ) : (
        <div className="divide-y divide-slate-50 dark:divide-slate-800 max-h-[320px] overflow-y-auto">
          {contacts.map((c) => (
            <CompactContactRow key={c.id} contact={c} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── By Project view ───────────────────────────────────────────────────
   QA3 Commit D (Item 6d, 2026-09-01). Grouped list — one card per
   project the caller can see that has at least one attached contact.
   Contacts come from project_partner_roles across every role except
   the buying-org 'customer' row (so participants, customer contacts,
   and every discipline-holder show up). Sourced from
   GET /projects/attached-contacts. */

function ByProjectView({
  groups, isLoading, onSelectContact, onOpenProject,
}: {
  groups: AttachedProject[];
  isLoading: boolean;
  onSelectContact: (id: number) => void;
  onOpenProject: (projectId: number) => void;
}) {
  if (isLoading) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
        Loading projects with attached contacts…
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
        <FolderOpen className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600 mb-3" />
        <p className="font-semibold text-slate-700 dark:text-slate-200">No projects with attached contacts yet</p>
        <p className="mt-1 text-[12px] text-slate-400 dark:text-slate-500">
          As soon as a project has participants, role-holders or customer contacts, they'll show up here grouped by project.
        </p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {groups.map((g) => (
        <ProjectContactsCard
          key={g.projectId}
          group={g}
          onSelectContact={onSelectContact}
          onOpenProject={onOpenProject}
        />
      ))}
    </div>
  );
}

function ProjectContactsCard({
  group, onSelectContact, onOpenProject,
}: {
  group: AttachedProject;
  onSelectContact: (id: number) => void;
  onOpenProject: (projectId: number) => void;
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header — clickable, opens the project detail page. Same
          affordance the CustomerCard uses (dedicated button that
          participates in focus order + keyboard access). */}
      <button
        type="button"
        onClick={() => onOpenProject(group.projectId)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left border-b border-slate-100 dark:border-slate-800 bg-gradient-to-br from-blue-50 to-white dark:from-blue-950/30 dark:to-slate-900 hover:bg-blue-50/60 dark:hover:bg-blue-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title={`Open ${group.projectName}`}
      >
        <div className="rounded-lg bg-blue-100 dark:bg-blue-900/50 p-2 shrink-0">
          <FolderKanban className="h-5 w-5 text-blue-700 dark:text-blue-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-[14px] text-slate-800 dark:text-slate-100 truncate" title={group.projectName}>
            {group.projectName}
          </h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {group.projectNumber && (
              <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300 mr-2">{group.projectNumber}</span>
            )}
            <span className="tabular-nums">
              {group.contacts.length} {group.contacts.length === 1 ? 'contact' : 'contacts'}
            </span>
          </p>
        </div>
        <ArrowRight className="h-4 w-4 text-slate-300 dark:text-slate-600 shrink-0" aria-hidden="true" />
      </button>

      {/* Contact rows. Per-project empty state deliberately unreachable
          — the API omits projects with no contacts (see
          ProjectsService.getAttachedContacts). Left as a defensive
          guard so a stale response never renders a blank card. */}
      {group.contacts.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
          No contacts on this project yet.
        </div>
      ) : (
        <div className="divide-y divide-slate-50 dark:divide-slate-800 max-h-[320px] overflow-y-auto">
          {group.contacts.map((c) => (
            <ProjectContactRow key={`${c.id}-${c.roleCode}`} c={c} onSelect={onSelectContact} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectContactRow({
  c, onSelect,
}: {
  c: AttachedProject['contacts'][number];
  onSelect: (id: number) => void;
}) {
  const isOrg = c.partnerType === 'organization';
  return (
    <button
      type="button"
      onClick={() => onSelect(c.id)}
      className="group w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-blue-50/40 dark:hover:bg-blue-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      title={`Open ${c.displayName}`}
    >
      {isOrg ? (
        <div className="rounded-full bg-violet-100 dark:bg-violet-900/40 p-1.5 shrink-0">
          <Building2 className="h-3.5 w-3.5 text-violet-700 dark:text-violet-300" />
        </div>
      ) : (
        <UserAvatar
          firstName={c.firstName ?? ''}
          lastName={c.lastName ?? ''}
          avatarUrl={null}
          size="sm"
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">
          {c.displayName}
          {c.isInternal && (
            <span
              className="ml-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
              title="Internal team member (has a login account)"
            >
              Internal
            </span>
          )}
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          <span className="text-slate-600 dark:text-slate-300">{c.titleInProject ?? c.roleName}</span>
          {c.orgName && (
            <> · <span className="text-slate-500 dark:text-slate-400">{c.orgName}</span></>
          )}
        </p>
      </div>
    </button>
  );
}

/** Tight contact row used inside CustomerCard + the orphan bucket. */
function CompactContactRow({ contact: c, onSelect }: { contact: Contact; onSelect: (id: number) => void }) {
  const phone = c.phone || c.mobile || '';
  return (
    <div
      onClick={() => onSelect(c.id)}
      className="group flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50/40 cursor-pointer transition-colors"
    >
      <UserAvatar firstName={c.firstName ?? ''} lastName={c.lastName ?? ''} avatarUrl={null} size="sm" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{c.displayName}</p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {c.mainRoleType?.name ?? <span className="italic text-slate-400 dark:text-slate-500">no role</span>}
          {c.projectCount.active > 0 && (
            <> · <span className="font-semibold text-emerald-700">{c.projectCount.active}</span> active proj.</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {c.email && (
          <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}
             className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title={c.email}>
            <Mail className="h-3.5 w-3.5" />
          </a>
        )}
        {phone && (
          <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()}
             className="rounded-md p-1.5 text-slate-400 dark:text-slate-500 hover:text-blue-600 hover:bg-blue-50" title={phone}>
            <Phone className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
