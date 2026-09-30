import { useState, useMemo, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, X, Mail, Phone, Building2, FolderKanban, Pencil, UserPlus, Upload,
  List as ListIcon, FolderOpen, Building, ExternalLink, MapPin,
  ChevronLeft, ChevronRight, ChevronDown, Plus, ArrowRight, Copy,
} from 'lucide-react';
import client from '@/api/client';
import { notify } from '@/lib/notify';
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
  // Main role type (Customer / Supplier / Consultant / …) — surfaces as
  // a type badge on the By-Organization view. Optional so older
  // responses without it still parse.
  mainRoleType?: { id: number; code: string; name: string } | null;
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

// CT-1 (2026-09-30) — primary Contacts view is now "By Organization":
// every BP-organization surfaces as a card with its people (worker_of
// edges) nested underneath, matching the mental model users already
// have from the contacts-import review screen. The old "By Customer"
// tab was a strict subset of this (customer orgs only) and has been
// dropped: the By-Org view supersedes it. "List" stays as a secondary
// flat view for scanning all contacts irrespective of employer.
type ViewMode = 'by-org' | 'list' | 'by-project';

const VIEW_TABS: Array<{ key: ViewMode; label: string; icon: React.ComponentType<{ className?: string }>; sub: string }> = [
  { key: 'by-org',      label: 'By Organization', icon: Building,   sub: 'People grouped by their employer' },
  { key: 'list',        label: 'List',            icon: ListIcon,   sub: 'Every contact in one table' },
  { key: 'by-project',  label: 'By Project',      icon: FolderOpen, sub: 'Contacts grouped per project' },
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
  // CT-1: default landing view is now "By Organization". The URL
  // parameter still wins so existing deep-links (?view=list, ?view=by-project)
  // stay honored; the legacy ?view=by-customer maps back to by-org
  // (the successor grouping) instead of silently falling through.
  const rawInitialView = searchParams.get('view');
  const initialView: ViewMode =
    rawInitialView === 'by-customer'
      ? 'by-org'
      : VIEW_TABS.some((t) => t.key === (rawInitialView as ViewMode))
        ? (rawInitialView as ViewMode)
        : 'by-org';
  const [view, setView] = useState<ViewMode>(initialView);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  // orgFilter drives a SERVER-side employerId param now — the previous
  // client-side .filter() over the loaded page silently hid employees
  // of that org whose row sat past row 200.
  const [orgFilter, setOrgFilter] = useState<string>('');
  // QA3 Wave-3 Commit 7: single table with an include-AMC toggle
  // (locked spec). Default OFF preserves the historical "external
  // contacts only" behavior — AMC employees keep living on the People
  // page. Turning it ON re-includes both internal identities
  // (user-linked + Internal-org worker_of) so the same table can
  // surface them without a second surface.
  const [includeAmc, setIncludeAmc] = useState(false);
  const [page, setPage] = useState(1);
  // Drawer identity in the URL (?contact=N) so refresh / outbound-return
  // restore it, matching the task-drawer's useDrawerRoute('task') pattern.
  const { drawerId: selectedId, openDrawer: openContact, closeDrawer: closeContact } = useDrawerRoute('contact');

  const perPage = view === 'list' ? LIST_PAGE_SIZE : GROUP_PAGE_SIZE;

  // "New Contact" opens the shared CreatePartnerModal pinned to person
  // mode via `lockPartnerType` (QA3 · Commit C, 2026-09-01). Rationale:
  // the Contacts screen is by definition about people; org creation
  // stays on the Partners page (`CreateOrganizationModal` there), so
  // there's no Person/Org toggle and no split-button menu on this
  // surface — consistent with PR-025's New-Project decision that
  // person-only entry points don't surface the toggle.
  const [showCreate, setShowCreate] = useState(false);
  // QA3 Commit D (Item 6a) — "Add contact" for a specific customer org.
  // When set, the CreatePartnerModal opens in person mode with the
  // employer preset + locked, so the flow explicitly reads "add a
  // contact at THIS customer" (matches the existing project Team
  // customer-contact adder convention).
  const [addContactForOrgId, setAddContactForOrgId] = useState<number | null>(null);

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
  //
  // People UX U3 (P-01 / P-02) — internal filtering is done SERVER-side
  // via `excludeInternal` when the AMC toggle is off; the client used to
  // slice the current page after loading, which hid externals that
  // sat past row 200 and inflated the total count. Now the server returns
  // the correct set + truthful total in one shot.
  const { data: contactsPage, isLoading: contactsLoading } = useQuery<ContactsPage>({
    // Prefix with 'business-partners' so the partner drawer's save mutations
    // (which invalidate ['business-partners']) cascade down to this query and
    // the list refreshes after an edit, without manual reload.
    queryKey: ['business-partners', 'contacts-list', view, page, perPage, debouncedSearch, statusFilter, orgFilter, includeAmc],
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: 'person',
          withProjects: true,
          page: view === 'list' ? page : 1,
          perPage,
          // People UX U3 — AMC toggle drives the server-side filter now.
          // When OFF (default) the server returns externals only.
          ...(!includeAmc ? { excludeInternal: true } : {}),
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

  // CT-1 (2026-09-30) — the dedicated "customers-for-contacts" query
  // that drove the old By-Customer view was dropped. The successor
  // By-Organization view iterates over every BP org (already loaded as
  // `orgsData` above) so the same customer subset — plus every other
  // employer — surfaces in one place.

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

  // People UX U3 (P-01, 2026-09-27) — internal filtering moved to the
  // server. The client used to load a whole page, then `.filter()` the
  // internal identities out, which meant an externals-total of 60 could
  // show as "showing 43 of 60" whenever the loaded 50-row page held
  // internals. Now the server returns the correct set (see
  // `excludeInternal` on the request above) so we can render `allContacts`
  // directly. When the AMC toggle is ON, we still lead with externals
  // for readability — matches the locked spec's "core consultants first"
  // ordering.
  const shownContacts = useMemo(() => {
    if (!includeAmc) return allContacts;
    return [...allContacts].sort((a, b) => {
      const aInt = a.user ? 1 : 0;
      const bInt = b.user ? 1 : 0;
      if (aInt !== bInt) return aInt - bInt; // externals (0) first
      return a.displayName.localeCompare(b.displayName);
    });
  }, [includeAmc, allContacts]);

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
  const visibleContacts = shownContacts;

  // People UX U3 (P-04, 2026-09-27) — "Copy external emails" now fetches
  // every match server-side and copies them all, not just the current
  // page. Uses the SAME filter set as the visible list, except
  // `excludeInternal` is forced to true so the button semantics stay
  // stable regardless of the AMC toggle. Cap at 2000 rows with a clear
  // notice if it hits.
  const COPY_CAP = 2000;
  const copyExternalEmails = async () => {
    try {
      const r = await client.get('/business-partners', {
        params: {
          partnerType: 'person',
          excludeInternal: true,
          perPage: COPY_CAP,
          page: 1,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter === 'active' ? 'active' : 'inactive' } : {}),
          ...(orgFilter ? { employerId: Number(orgFilter) } : {}),
        },
      });
      const body = r.data?.data ?? r.data;
      const rows: Contact[] = Array.isArray(body) ? body : (body?.data ?? []);
      const total: number = body?.meta?.total ?? rows.length;
      const emails = rows
        .map((c) => (c.email ?? '').trim())
        .filter((e) => !!e);
      const deduped = Array.from(new Set(emails));
      if (deduped.length === 0) {
        notify.warning('No external emails to copy', { code: 'CONTACTS-COPY-EMPTY' });
        return;
      }
      await navigator.clipboard.writeText(deduped.join(', '));
      const capNote =
        total > COPY_CAP
          ? ` (capped at ${COPY_CAP} of ${total} — narrow the filters to reach the rest)`
          : '';
      notify.success(
        `Copied ${deduped.length} email${deduped.length === 1 ? '' : 's'}${capNote}`,
        { code: 'CONTACTS-COPY-200' },
      );
    } catch (err: any) {
      notify.apiError(err, 'Failed to copy external emails');
    }
  };

  const hasFilters = !!debouncedSearch || statusFilter !== 'active' || !!orgFilter || includeAmc;

  // Header count string — server total when available so the badge is
  // truthful even when the current page holds only a slice. Falls back
  // to the loaded-page count for the initial render before meta lands.
  const totalCount = meta?.total ?? allContacts.length;
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
        {/* "New Contact" — single, person-only entry point (QA3 · Commit
            C, 2026-09-01). The split-button/menu that used to offer a
            "New Organization" alternative was removed: this surface is
            about people; org creation stays on the Partners page. The
            modal opens with `lockPartnerType`, so the internal
            Person/Org toggle is hidden here (mirrors the
            add-contact-from-customer-drawer flow in Commit D). */}
        {/* QA3 Wave-3 Commit 7: copy every external contact's email to
            the clipboard, comma-joined, so users can paste directly
            into an email client's To/CC field. Deliberately independent
            of the AMC toggle — "external" is a stable concept the
            button name promises. */}
        <button
          type="button"
          onClick={copyExternalEmails}
          className="inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:border-slate-400 dark:hover:border-slate-500"
          title="Copy all external contact emails (matching current filters) to the clipboard"
          disabled={contactsLoading}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copy external emails
        </button>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm"
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" /> New Contact
        </button>
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
        {/* QA3 Wave-3 Commit 7: include-AMC toggle. Default OFF so the
            surface still leads with externals (locked spec); flipping
            it ON re-includes internals (user-linked BPs + Internal-org
            worker_of edges). Same table, no second surface. */}
        <label className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeAmc}
            onChange={(e) => setIncludeAmc(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
          />
          Include AMEC employees
        </label>
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

      {/* View toggle — People UX M5 (E-27). role=tablist + role=tab +
          aria-selected, and arrow-key navigation via the shared Tabs
          contract (`role="tab"` roving tabIndex is handled by the
          hand-rolled markup below). The URL is already synchronized
          via `switchView` writing `?view=` upstream. */}
      <div
        role="tablist"
        aria-label="Contacts views"
        className="flex gap-1.5 flex-nowrap overflow-x-auto border-b border-slate-200 dark:border-slate-700"
      >
        {VIEW_TABS.map((t, i) => {
          const Icon = t.icon;
          const active = view === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => switchView(t.key)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  const next = VIEW_TABS[(i + 1) % VIEW_TABS.length];
                  if (next) switchView(next.key);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const next = VIEW_TABS[(i - 1 + VIEW_TABS.length) % VIEW_TABS.length];
                  if (next) switchView(next.key);
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  const next = VIEW_TABS[0];
                  if (next) switchView(next.key);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  const next = VIEW_TABS[VIEW_TABS.length - 1];
                  if (next) switchView(next.key);
                }
              }}
              className={cn(
                '-mb-px rounded-t-lg border border-b-2 px-4 py-2.5 text-sm font-bold transition-colors shrink-0 whitespace-nowrap inline-flex items-center gap-2',
                active
                  ? 'border-slate-200 dark:border-slate-700 border-b-blue-600 bg-blue-50 text-blue-700'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
              <span className={cn('ml-1 text-[11px] font-medium', active ? 'text-blue-500' : 'text-slate-400 dark:text-slate-500')}>
                {t.sub}
              </span>
            </button>
          );
        })}
      </div>

      {/* View body */}
      {contactsLoading ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">Loading contacts…</div>
      ) : visibleContacts.length === 0 ? (
        // People UX U3 — filtered empty state offers a Clear filters
        // button; first-use state drops the "Partners → Add Contact"
        // fossil (that flow no longer exists) and points at "New
        // Contact" above instead.
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm">
          {hasFilters ? (
            <div className="flex flex-col items-center gap-3 text-slate-500 dark:text-slate-400">
              <p className="italic">No contacts match the current filters.</p>
              <button
                type="button"
                onClick={() => { setSearch(''); setStatusFilter('active'); setOrgFilter(''); setIncludeAmc(false); }}
                className="inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear filters
              </button>
            </div>
          ) : (
            <p className="italic text-slate-400 dark:text-slate-500">
              No external contacts yet. Click "New Contact" above to add the first one.
            </p>
          )}
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
        <ByOrganizationView
          orgs={orgs}
          contacts={visibleContacts}
          onSelect={openContact}
          onAddContact={(orgId) => setAddContactForOrgId(orgId)}
          onOpenOrg={openContact}
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

      {/* Shared creation modal — person-only on this surface (QA3 ·
          Commit C). `lockPartnerType` hides the internal Person/Org
          toggle inside the modal so the flow can't be flipped to
          organization mid-form. Newly-created contact opens in the
          drawer via useDrawerRoute so the URL reflects the state. */}
      {showCreate && (
        <CreatePartnerModal
          defaultPartnerType="person"
          lockPartnerType
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); openContact(id); }}
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

/* ─── By Organization view ──────────────────────────────────────────────
   CT-1b (2026-09-30) — reshaped as a grouped table to match By Project.

   Same chrome as ByProjectView: one rounded container with a sticky
   4-column header (Contact · Role · Email · Phone), one <tbody> per
   org holding a sticky group-header row (chevron · Building2 · org
   name · type badge · contact count · "Open org →"). The Organization
   column dropped — the group header IS the org. Toolbar sits above
   the table with a free-text filter (matches name/role/email/phone) +
   "N contacts across M organizations" + Expand/Collapse all.

   Data source unchanged: /business-partners?partnerType=person&withProjects=true.
   Grouping key is the person's `worker_of` edge target (partyBId);
   people with no `worker_of` land in a trailing "Unaffiliated" group.
   Sort control keeps its two modes (count / name) — the group order
   for the table body reads from it.
*/

type ByOrgSort = 'count' | 'name';
type ByOrgSortKey = 'name' | 'role' | 'email' | 'phone';
type ByOrgSortDir = 'asc' | 'desc';

interface ByOrgRow {
  orgId: number | null; // null = Unaffiliated bucket
  orgName: string | null;
  orgTypeBadge: string; // "Partner" / "Customer" / "Organization" / …
  contactId: number;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  role: string; // mainRoleType.name or ''
  email: string | null;
  phone: string | null;
  rowKey: string;
}

function ByOrganizationView({
  orgs, contacts, onSelect, onAddContact, onOpenOrg,
}: {
  orgs: Org[];
  contacts: Contact[];
  onSelect: (id: number) => void;
  onAddContact: (orgId: number) => void;
  onOpenOrg: (orgId: number) => void;
}) {
  // Which org grouping to sort by (secondary to the header-column
  // sort — the two apply in different scopes). Kept behind a small
  // toolbar control so the count-vs-name intent stays discoverable.
  const [orgSort, setOrgSort] = useState<ByOrgSort>('count');
  // Column sort — same tri-state cycle as By Project (asc → desc → clear).
  const [sort, setSort] = useState<{ key: ByOrgSortKey; dir: ByOrgSortDir } | null>(null);
  // Free-text filter across name/role/email/phone. Debounced so a
  // typing user doesn't re-flatten the grid on every keystroke.
  const [filter, setFilter] = useState('');
  const debouncedFilter = useDebounce(filter, 200);
  // Which org bodies are collapsed. Empty = everyone expanded (matches
  // the historical default so the first paint is dense with content).
  const [collapsedOrgs, setCollapsedOrgs] = useState<Set<number>>(new Set());
  // "Unaffiliated" bucket has no numeric org id; use a sentinel so it
  // participates in the same collapsed-set logic as real org groups.
  const UNAFFILIATED_ID = -1;

  const orgById = useMemo(() => {
    const m = new Map<number, Org>();
    for (const o of orgs) m.set(o.id, o);
    return m;
  }, [orgs]);

  // Flatten every person + their worker_of edges into row records.
  // A person with N worker_of edges surfaces N rows (they work at N
  // orgs — same read the old card grid used). No edge → Unaffiliated.
  const allRows: ByOrgRow[] = useMemo(() => {
    const out: ByOrgRow[] = [];
    for (const c of contacts) {
      const workerEdges = (c.partnerRelationshipsA ?? []).filter(
        (r) => r.type?.code === 'worker_of',
      );
      const role = c.mainRoleType?.name ?? '';
      const phone = c.phone || c.mobile || '';
      if (workerEdges.length === 0) {
        out.push({
          orgId: null,
          orgName: null,
          orgTypeBadge: 'Unaffiliated',
          contactId: c.id,
          displayName: c.displayName,
          firstName: c.firstName,
          lastName: c.lastName,
          role,
          email: c.email,
          phone: phone || null,
          rowKey: `unaff-${c.id}`,
        });
        continue;
      }
      const seen = new Set<number>();
      for (const r of workerEdges) {
        if (seen.has(r.partyBId)) continue; // dedupe multi-edges to same org
        seen.add(r.partyBId);
        const org = orgById.get(r.partyBId);
        out.push({
          orgId: r.partyBId,
          orgName: org?.displayName ?? `Organization #${r.partyBId}`,
          orgTypeBadge: org?.mainRoleType?.name ?? 'Organization',
          contactId: c.id,
          displayName: c.displayName,
          firstName: c.firstName,
          lastName: c.lastName,
          role,
          email: c.email,
          phone: phone || null,
          rowKey: `${r.partyBId}-${c.id}`,
        });
      }
    }
    return out;
  }, [contacts, orgById]);

  // Free-text filter — matches EVERY high-signal field. Applied
  // BEFORE grouping so an org whose all rows fail the filter drops
  // out of the table entirely (empty groups are noise).
  const filteredRows = useMemo(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) =>
      r.displayName.toLowerCase().includes(q) ||
      (r.email ?? '').toLowerCase().includes(q) ||
      (r.phone ?? '').toLowerCase().includes(q) ||
      r.role.toLowerCase().includes(q) ||
      (r.orgName ?? '').toLowerCase().includes(q),
    );
  }, [allRows, debouncedFilter]);

  // Header-driven column sort. Applied AFTER filter and BEFORE group
  // assembly so within-org row order reflects the current sort.
  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = sort.key;
    const value = (r: ByOrgRow): string => {
      switch (key) {
        case 'name': return r.displayName;
        case 'role': return r.role;
        case 'email': return r.email ?? '';
        case 'phone': return r.phone ?? '';
      }
    };
    return [...filteredRows].sort((a, b) => value(a).localeCompare(value(b)) * dir);
  }, [filteredRows, sort]);

  // Assemble groups. Order = orgSort (count-desc | name-asc); the
  // Unaffiliated bucket ALWAYS tail-sorts (never surprises the user
  // as the first group).
  const groups = useMemo(() => {
    const map = new Map<number, ByOrgRow[]>();
    const unaff: ByOrgRow[] = [];
    for (const r of sortedRows) {
      if (r.orgId == null) {
        unaff.push(r);
        continue;
      }
      const arr = map.get(r.orgId) ?? [];
      arr.push(r);
      map.set(r.orgId, arr);
    }
    const orgGroups = Array.from(map.entries()).map(([orgId, rows]) => {
      const first = rows[0]!;
      return {
        orgId,
        orgName: first.orgName ?? '',
        orgTypeBadge: first.orgTypeBadge,
        rows,
      };
    });
    if (orgSort === 'count') {
      orgGroups.sort((a, b) => {
        if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
        return a.orgName.localeCompare(b.orgName);
      });
    } else {
      orgGroups.sort((a, b) => a.orgName.localeCompare(b.orgName));
    }
    const out: Array<
      | { kind: 'org'; orgId: number; orgName: string; orgTypeBadge: string; rows: ByOrgRow[] }
      | { kind: 'unaffiliated'; rows: ByOrgRow[] }
    > = orgGroups.map((g) => ({ kind: 'org' as const, ...g }));
    if (unaff.length > 0) out.push({ kind: 'unaffiliated', rows: unaff });
    return out;
  }, [sortedRows, orgSort]);

  const toggleSort = (k: ByOrgSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== k) return { key: k, dir: 'asc' };
      if (prev.dir === 'asc') return { key: k, dir: 'desc' };
      return null;
    });
  };
  const toggleGroup = (id: number) => {
    setCollapsedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allCollapsed =
    groups.length > 0 &&
    groups.every((g) =>
      collapsedOrgs.has(g.kind === 'org' ? g.orgId : UNAFFILIATED_ID),
    );
  const applyExpandAll = () => setCollapsedOrgs(new Set());
  const applyCollapseAll = () => {
    const next = new Set<number>();
    for (const g of groups) {
      next.add(g.kind === 'org' ? g.orgId : UNAFFILIATED_ID);
    }
    setCollapsedOrgs(next);
  };

  const orgGroupCount = groups.filter((g) => g.kind === 'org').length;
  const totalContactRows = sortedRows.length;

  if (allRows.length === 0) {
    return (
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
        <Building className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600 mb-3" />
        <p className="font-semibold text-slate-700 dark:text-slate-200">No contacts to group yet</p>
        <p className="mt-1 text-[12px] text-slate-400 dark:text-slate-500">
          Add contacts and link them to an organization to see them grouped here. Contacts
          without an employer still show up in the "Unaffiliated" group.
        </p>
      </div>
    );
  }

  // 4 columns; keep in sync with the header + tbody rows below.
  const columns: Array<{ key: ByOrgSortKey; label: string }> = [
    { key: 'name',  label: 'Contact' },
    { key: 'role',  label: 'Role' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
  ];

  return (
    <div className="space-y-3">
      {/* Toolbar — free-text filter + orgs-with-contacts summary +
          expand/collapse all shortcut. Same shape as By Project so
          both surfaces read identically. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, role, email, phone, org…"
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-9 py-2 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              title="Clear filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{totalContactRows}</span>
            {' '}contact{totalContactRows === 1 ? '' : 's'} across{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-200">{orgGroupCount}</span>
            {' '}organization{orgGroupCount === 1 ? '' : 's'}
          </span>
          <label className="inline-flex items-center gap-1.5">
            <span>Sort orgs:</span>
            <select
              value={orgSort}
              onChange={(e) => setOrgSort(e.target.value as ByOrgSort)}
              className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200"
              aria-label="Sort organizations"
            >
              <option value="count">Most contacts</option>
              <option value="name">Name (A→Z)</option>
            </select>
          </label>
          <button
            type="button"
            onClick={allCollapsed ? applyExpandAll : applyCollapseAll}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            disabled={groups.length === 0}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
          No rows match the current filter.
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#FAFBFC] dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-800 backdrop-blur">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className="text-left px-3 py-2 text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-100"
                      >
                        <span>{c.label}</span>
                        <span className="text-slate-300 dark:text-slate-600 text-[9px] font-mono">
                          {sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map((g) => {
                const groupId = g.kind === 'org' ? g.orgId : UNAFFILIATED_ID;
                const collapsed = collapsedOrgs.has(groupId);
                return (
                  <tbody key={groupId} className="divide-y divide-slate-100 dark:divide-slate-800">
                    {/* Group header — full-width cell with the org
                        name / type badge / count and inline "Open org"
                        + "+ Add contact" affordances. Sticky under the
                        column header so it stays anchored while long
                        groups scroll. */}
                    <tr
                      className="bg-slate-50/95 dark:bg-slate-800/95 backdrop-blur sticky z-10"
                      style={{ top: 34 }}
                    >
                      <td colSpan={columns.length} className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleGroup(groupId)}
                            aria-expanded={!collapsed}
                            className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            {g.kind === 'org' ? (
                              <>
                                <Building2 className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" />
                                <span className="normal-case tracking-normal text-slate-800 dark:text-slate-100">{g.orgName}</span>
                                <span
                                  className="normal-case tracking-normal inline-flex items-center rounded-[5px] bg-violet-600/10 px-2 py-0.5 text-[11px] font-bold text-violet-700 dark:text-violet-300"
                                  title="Organization type"
                                >
                                  {g.orgTypeBadge}
                                </span>
                              </>
                            ) : (
                              <>
                                <UserPlus className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                                <span className="normal-case tracking-normal text-slate-700 dark:text-slate-200">Unaffiliated</span>
                                <span
                                  className="normal-case tracking-normal inline-flex items-center rounded-[5px] bg-slate-200/70 dark:bg-slate-700/60 px-2 py-0.5 text-[11px] font-bold text-slate-600 dark:text-slate-300"
                                  title="Contacts without a worker_of edge"
                                >
                                  No employer
                                </span>
                              </>
                            )}
                            <span className="text-slate-400 dark:text-slate-500 font-mono font-medium tabular-nums">
                              {g.rows.length}
                            </span>
                          </button>
                          <div className="ml-auto flex items-center gap-1">
                            {g.kind === 'org' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => onAddContact(g.orgId)}
                                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:hover:text-blue-300"
                                  title={`Add a contact at ${g.orgName}`}
                                >
                                  <Plus className="h-3 w-3" aria-hidden="true" />
                                  Add contact
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onOpenOrg(g.orgId)}
                                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
                                  title={`Open ${g.orgName}`}
                                >
                                  Open org
                                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                    {!collapsed && g.rows.map((r) => (
                      <ByOrgTableRow key={r.rowKey} row={r} onSelect={onSelect} />
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** CT-1b (2026-09-30) — per-contact table row for the grouped-table
 *  By-Organization view. Deliberately its own component so the row's
 *  click handler doesn't leak into the group header row above it. */
function ByOrgTableRow({
  row: r, onSelect,
}: {
  row: ByOrgRow;
  onSelect: (contactId: number) => void;
}) {
  return (
    <tr
      onClick={() => onSelect(r.contactId)}
      className="cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/40"
    >
      <td className="px-3 py-2 align-middle">
        <div className="flex items-center gap-2 min-w-0">
          <UserAvatar
            firstName={r.firstName ?? ''}
            lastName={r.lastName ?? ''}
            avatarUrl={null}
            size="sm"
          />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate" title={r.displayName}>
              {r.displayName}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200">
        {r.role || <span className="italic text-slate-400 dark:text-slate-500">—</span>}
      </td>
      <td className="px-3 py-2 text-[13px]">
        {r.email ? (
          <a
            href={`mailto:${r.email}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700 truncate max-w-full"
            title={r.email}
          >
            <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="truncate">{r.email}</span>
          </a>
        ) : (
          <span className="text-slate-300 dark:text-slate-600 italic">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-[13px]">
        {r.phone ? (
          <a
            href={`tel:${r.phone}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700"
          >
            <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="tabular-nums font-mono">{r.phone}</span>
          </a>
        ) : (
          <span className="text-slate-300 dark:text-slate-600 italic">—</span>
        )}
      </td>
    </tr>
  );
}

/* ─── By Project view ───────────────────────────────────────────────────
   CT-2 (2026-09-30) — rewritten as a grouped table so users can scan
   contacts across projects the same way they scan people on People or
   team members on the Team tab. One <tbody> per project holds a sticky
   group header row (project name + number + count + "Open project"),
   followed by the contact rows. Columns follow the app's table
   convention: uppercase 11px header on #FAFBFC, 13px body, hover
   highlight, no rings on focus.

   Sort is header-click driven (asc → desc → clear). Filter is a single
   free-text input above the table that matches name / role / email /
   phone / org / project — the same "one box that searches everything"
   pattern People uses. Both apply BEFORE grouping so an empty project
   drops out of the table entirely when filters exclude all its rows.

   Data source is unchanged: GET /projects/attached-contacts. */

type ByProjectSortKey = 'name' | 'role' | 'email' | 'phone' | 'org';
type ByProjectSortDir = 'asc' | 'desc';

interface ByProjectRow {
  projectId: number;
  projectName: string;
  projectNumber: string | null;
  contactId: number;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  partnerType: 'person' | 'organization';
  email: string | null;
  phone: string | null;
  role: string;
  orgName: string | null;
  isInternal: boolean;
  rowKey: string;
}

function ByProjectView({
  groups, isLoading, onSelectContact, onOpenProject,
}: {
  groups: AttachedProject[];
  isLoading: boolean;
  onSelectContact: (id: number) => void;
  onOpenProject: (projectId: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const debouncedFilter = useDebounce(filter, 200);
  const [sort, setSort] = useState<{ key: ByProjectSortKey; dir: ByProjectSortDir } | null>(null);
  // Which project bodies are collapsed. Empty = everyone expanded.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<number>>(new Set());

  // Flatten API groups into row records so sort + filter are one-pass.
  const allRows: ByProjectRow[] = useMemo(() => {
    const out: ByProjectRow[] = [];
    for (const g of groups) {
      for (const c of g.contacts) {
        out.push({
          projectId: g.projectId,
          projectName: g.projectName,
          projectNumber: g.projectNumber,
          contactId: c.id,
          displayName: c.displayName,
          firstName: c.firstName,
          lastName: c.lastName,
          partnerType: c.partnerType,
          email: c.email,
          phone: null, // attached-contacts endpoint doesn't ship phone today
          role: c.titleInProject ?? c.roleName,
          orgName: c.orgName,
          isInternal: c.isInternal,
          rowKey: `${g.projectId}-${c.id}-${c.roleCode}`,
        });
      }
    }
    return out;
  }, [groups]);

  const filteredRows = useMemo(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => {
      return (
        r.displayName.toLowerCase().includes(q) ||
        (r.email ?? '').toLowerCase().includes(q) ||
        (r.phone ?? '').toLowerCase().includes(q) ||
        r.role.toLowerCase().includes(q) ||
        (r.orgName ?? '').toLowerCase().includes(q) ||
        r.projectName.toLowerCase().includes(q) ||
        (r.projectNumber ?? '').toLowerCase().includes(q)
      );
    });
  }, [allRows, debouncedFilter]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = sort.key;
    const value = (r: ByProjectRow): string => {
      switch (key) {
        case 'name': return r.displayName;
        case 'role': return r.role;
        case 'email': return r.email ?? '';
        case 'phone': return r.phone ?? '';
        case 'org': return r.orgName ?? '';
      }
    };
    return [...filteredRows].sort((a, b) => value(a).localeCompare(value(b)) * dir);
  }, [filteredRows, sort]);

  // Group sorted rows by project. Keep project order stable: first
  // appearance in the sorted output — respects the sort so grouping
  // stays consistent (project A ordering by name, project A rows sorted).
  const projectGroups = useMemo(() => {
    const map = new Map<number, ByProjectRow[]>();
    const projectOrder: number[] = [];
    for (const r of sortedRows) {
      if (!map.has(r.projectId)) {
        map.set(r.projectId, []);
        projectOrder.push(r.projectId);
      }
      map.get(r.projectId)!.push(r);
    }
    return projectOrder.map((pid) => {
      const rows = map.get(pid)!;
      return {
        projectId: pid,
        projectName: rows[0]!.projectName,
        projectNumber: rows[0]!.projectNumber,
        rows,
      };
    });
  }, [sortedRows]);

  const toggleSort = (k: ByProjectSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== k) return { key: k, dir: 'asc' };
      if (prev.dir === 'asc') return { key: k, dir: 'desc' };
      return null;
    });
  };
  const toggleProject = (pid: number) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };
  const allCollapsed = projectGroups.length > 0 && projectGroups.every((g) => collapsedProjects.has(g.projectId));
  const applyExpandAll = () => setCollapsedProjects(new Set());
  const applyCollapseAll = () => setCollapsedProjects(new Set(projectGroups.map((g) => g.projectId)));

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

  const columns: Array<{ key: ByProjectSortKey; label: string; className?: string }> = [
    { key: 'name',  label: 'Contact' },
    { key: 'role',  label: 'Role on project' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'org',   label: 'Organization' },
  ];

  return (
    <div className="space-y-3">
      {/* Table toolbar — free-text filter + collapse/expand all shortcut.
          The filter matches everything (name / role / email / phone /
          org / project), the same "one box" pattern the People screen
          uses. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, role, email, phone, org, project…"
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              title="Clear filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
          <span className="tabular-nums">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{sortedRows.length}</span>
            {' '}row{sortedRows.length === 1 ? '' : 's'} across{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-200">{projectGroups.length}</span>
            {' '}project{projectGroups.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={allCollapsed ? applyExpandAll : applyCollapseAll}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
            disabled={projectGroups.length === 0}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      </div>

      {projectGroups.length === 0 ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
          No rows match the current filter.
        </div>
      ) : (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-20">
                <tr className="bg-[#FAFBFC] dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-800 backdrop-blur">
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className="text-left px-3 py-2 text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-100"
                      >
                        <span>{c.label}</span>
                        <span className="text-slate-300 dark:text-slate-600 text-[9px] font-mono">
                          {sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              {projectGroups.map((g) => {
                const collapsed = collapsedProjects.has(g.projectId);
                return (
                  <tbody key={g.projectId} className="divide-y divide-slate-100 dark:divide-slate-800">
                    {/* Group header — a full-width cell with the project
                        name / number / count and an inline "Open project"
                        affordance. Sticky under the column header so it
                        stays anchored while long groups scroll. */}
                    <tr
                      className="bg-slate-50/95 dark:bg-slate-800/95 backdrop-blur sticky z-10"
                      style={{ top: 34 }}
                    >
                      <td colSpan={columns.length} className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleProject(g.projectId)}
                            aria-expanded={!collapsed}
                            className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
                          >
                            {collapsed ? (
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <FolderKanban className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                            <span className="normal-case tracking-normal">{g.projectName}</span>
                            {g.projectNumber && (
                              <span className="font-mono normal-case tracking-normal text-slate-500 dark:text-slate-400 text-[11px]">
                                {g.projectNumber}
                              </span>
                            )}
                            <span className="text-slate-400 dark:text-slate-500 font-mono font-medium">
                              {g.rows.length}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenProject(g.projectId)}
                            className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500"
                            title={`Open ${g.projectName}`}
                          >
                            Open project
                            <ArrowRight className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {!collapsed && g.rows.map((r) => (
                      <ByProjectTableRow
                        key={r.rowKey}
                        row={r}
                        onSelect={onSelectContact}
                      />
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** CT-2 — table row for the By-Project view. Deliberately its own
 *  component so the row-level click handler + hover state don't leak
 *  into the group header row above it. */
function ByProjectTableRow({
  row: r, onSelect,
}: {
  row: ByProjectRow;
  onSelect: (contactId: number) => void;
}) {
  const isOrg = r.partnerType === 'organization';
  return (
    <tr
      onClick={() => onSelect(r.contactId)}
      className="cursor-pointer hover:bg-slate-50/60 dark:hover:bg-slate-800/40"
    >
      <td className="px-3 py-2 align-middle">
        <div className="flex items-center gap-2 min-w-0">
          {isOrg ? (
            <div className="rounded-full bg-violet-100 dark:bg-violet-900/40 p-1.5 shrink-0">
              <Building2 className="h-3.5 w-3.5 text-violet-700 dark:text-violet-300" />
            </div>
          ) : (
            <UserAvatar
              firstName={r.firstName ?? ''}
              lastName={r.lastName ?? ''}
              avatarUrl={null}
              size="sm"
            />
          )}
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate" title={r.displayName}>
              {r.displayName}
              {r.isInternal && (
                <span
                  className="ml-1.5 rounded-[5px] bg-emerald-600/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                  title="Internal team member (has a login account)"
                >
                  Internal
                </span>
              )}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-[13px] text-slate-700 dark:text-slate-200">
        {r.role || <span className="italic text-slate-400 dark:text-slate-500">—</span>}
      </td>
      <td className="px-3 py-2 text-[13px]">
        {r.email ? (
          <a
            href={`mailto:${r.email}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700 truncate max-w-full"
            title={r.email}
          >
            <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="truncate">{r.email}</span>
          </a>
        ) : (
          <span className="text-slate-300 dark:text-slate-600 italic">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-[13px]">
        {r.phone ? (
          <a
            href={`tel:${r.phone}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200 hover:text-blue-700"
          >
            <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="tabular-nums">{r.phone}</span>
          </a>
        ) : (
          <span className="text-slate-300 dark:text-slate-600 italic">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-[13px] text-slate-600 dark:text-slate-300">
        {r.orgName ? (
          <span className="inline-flex items-center gap-1.5 truncate max-w-full" title={r.orgName}>
            <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="truncate">{r.orgName}</span>
          </span>
        ) : (
          <span className="text-slate-300 dark:text-slate-600 italic">—</span>
        )}
      </td>
    </tr>
  );
}

