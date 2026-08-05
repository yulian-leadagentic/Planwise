import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, X, Mail, Phone, Building2, FolderKanban, Pencil, UserPlus,
  List as ListIcon, FolderOpen, Building, ExternalLink, MapPin, UserCircle2,
} from 'lucide-react';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { UserAvatar } from '@/components/shared/user-avatar';
import { PartnerDrawer } from './partner-drawer';

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
  outgoingRelationships: Array<{
    targetType: string;
    targetId: number;
    relationshipType: { code: string; name: string } | null;
  }>;
  user: { id: number; isActive: boolean } | null;
  projectCount: { active: number; archived: number };
  projects: ContactProject[];
};

type Org = {
  id: number;
  displayName: string;
  companyName: string | null;
};

type ViewMode = 'list' | 'by-project' | 'by-customer';

const VIEW_TABS: Array<{ key: ViewMode; label: string; icon: React.ComponentType<{ className?: string }>; sub: string }> = [
  { key: 'list',        label: 'List',        icon: ListIcon, sub: 'Every contact in one table' },
  { key: 'by-project',  label: 'By Project',  icon: FolderOpen, sub: 'Contacts grouped per project' },
  { key: 'by-customer', label: 'By Customer', icon: Building, sub: 'Contacts grouped per customer org' },
];

export function ContactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialView = (searchParams.get('view') as ViewMode) ?? 'list';
  const [view, setView] = useState<ViewMode>(
    VIEW_TABS.some((t) => t.key === initialView) ? initialView : 'list',
  );
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [orgFilter, setOrgFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Sync view to URL so deep-links/back button work.
  const switchView = (v: ViewMode) => {
    setView(v);
    const next = new URLSearchParams(searchParams);
    next.set('view', v);
    setSearchParams(next, { replace: true });
  };

  // Contacts (persons with project enrichment). queryFn unwraps both the
  // axios envelope (r.data) and the API's success wrapper (r.data.data) and
  // returns the plain array — consumers below treat allContacts as Contact[].
  const { data: contactsData, isLoading: contactsLoading } = useQuery<Contact[]>({
    // Prefix with 'business-partners' so the partner drawer's save mutations
    // (which invalidate ['business-partners']) cascade down to this query and
    // the list refreshes after an edit, without manual reload.
    queryKey: ['business-partners', 'contacts-list', debouncedSearch, statusFilter],
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: 'person',
          withProjects: true,
          perPage: 200,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter === 'active' ? 'active' : 'inactive' } : {}),
        },
      }).then((r) => {
        const body = r.data?.data ?? r.data;
        // The list endpoint returns { data: [...], meta: {...} } inside the
        // success wrapper, so peel one more level when needed.
        return Array.isArray(body) ? body : (body?.data ?? []);
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

  // Customer organizations specifically — drives the By Customer view. We
  // ask the API for orgs that hold the "customer" role-type so we don't have
  // to filter client-side and we don't miss orgs whose main_role is set but
  // are also in the roles list.
  const { data: customersData } = useQuery<Org[]>({
    queryKey: ['business-partners', 'customers-for-contacts'],
    queryFn: () =>
      client.get('/business-partners', {
        params: { partnerType: 'organization', roleType: 'customer', perPage: 200 },
      }).then((r) => {
        const body = r.data?.data ?? r.data;
        return Array.isArray(body) ? body : (body?.data ?? []);
      }),
    staleTime: 5 * 60_000,
  });

  const allContacts: Contact[] = contactsData ?? [];
  const orgs: Org[] = orgsData ?? [];
  const orgNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of orgs) m.set(o.id, o.displayName);
    return m;
  }, [orgs]);

  // Identity rule — anyone with a login account is INTERNAL staff, belongs
  // in /people not Contacts. (See partners-page comment for the history.)
  const externalContacts = useMemo(
    () => allContacts.filter((c) => !c.user),
    [allContacts],
  );

  // Org filter values — only the employers that actually appear on this set.
  const employerOrgs = useMemo(() => {
    const ids = new Set<number>();
    for (const c of externalContacts) {
      for (const r of c.outgoingRelationships ?? []) {
        if (r.relationshipType?.code === 'worker_of' && r.targetType === 'organization') {
          ids.add(r.targetId);
        }
      }
    }
    return Array.from(ids)
      .map((id) => ({ id, name: orgNameById.get(id) ?? `#${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [externalContacts, orgNameById]);

  const visibleContacts = useMemo(() => {
    return externalContacts.filter((c) => {
      if (orgFilter) {
        const matches = (c.outgoingRelationships ?? []).some(
          (r) => r.relationshipType?.code === 'worker_of'
            && r.targetType === 'organization'
            && String(r.targetId) === orgFilter,
        );
        if (!matches) return false;
      }
      return true;
    });
  }, [externalContacts, orgFilter]);

  const hasFilters = !!search || statusFilter !== 'active' || !!orgFilter;

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
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white"
          onClick={() => {/* opens new-contact flow — wired in Turn 3 polish */}}
          title="Coming next: dedicated new-contact form"
        >
          <UserPlus className="h-4 w-4" /> New Contact
        </button>
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
            <option key={o.id} value={o.id}>{o.name}</option>
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
          {visibleContacts.length} of {externalContacts.length} contacts
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
        <ContactsListView contacts={visibleContacts} orgNameById={orgNameById} onSelect={setSelectedId} />
      ) : view === 'by-project' ? (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
          <FolderOpen className="mx-auto h-10 w-10 text-slate-300 dark:text-slate-600 mb-3" />
          <p className="font-semibold text-slate-700 dark:text-slate-200">By Project view — coming next</p>
          <p className="mt-1 text-[12px] text-slate-400 dark:text-slate-500">Project cards with stacked contact avatars; click a stack to expand.</p>
        </div>
      ) : (
        <ByCustomerView
          customers={customersData ?? []}
          contacts={visibleContacts}
          onSelect={setSelectedId}
        />
      )}

      {/* Drawer for editing a contact (reuses the partner drawer). */}
      {selectedId !== null && (
        <PartnerDrawer
          partnerId={selectedId}
          onClose={() => setSelectedId(null)}
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
        const workerOf = (c.outgoingRelationships ?? []).find(
          (r) => r.relationshipType?.code === 'worker_of' && r.targetType === 'organization',
        );
        const employerName = workerOf
          ? (orgNameById.get(workerOf.targetId) ?? `Organization #${workerOf.targetId}`)
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
  customers, contacts, onSelect,
}: {
  customers: Org[];
  contacts: Contact[];
  onSelect: (id: number) => void;
}) {
  // Group contacts by their worker_of org id.
  const byOrg = useMemo(() => {
    const m = new Map<number, Contact[]>();
    for (const c of contacts) {
      for (const r of c.outgoingRelationships ?? []) {
        if (r.relationshipType?.code === 'worker_of' && r.targetType === 'organization') {
          const arr = m.get(r.targetId) ?? [];
          if (!arr.some((x) => x.id === c.id)) arr.push(c);
          m.set(r.targetId, arr);
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
    const workerOf = (c.outgoingRelationships ?? []).find(
      (r) => r.relationshipType?.code === 'worker_of' && r.targetType === 'organization',
    );
    if (!workerOf) return true; // contact with no employer
    return !customerIds.has(workerOf.targetId); // employer isn't a customer
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
          Add an organization from <span className="font-mono text-slate-500 dark:text-slate-400">Partners → Organizations</span> and tag it
          with the <span className="font-mono text-slate-500 dark:text-slate-400">customer</span> role to see it here.
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
  customer, contacts, onSelect,
}: {
  customer: Org;
  contacts: Contact[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="border-b border-slate-100 dark:border-slate-800 px-4 py-3 bg-gradient-to-br from-purple-50 to-white">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-100 p-2 shrink-0">
            <Building2 className="h-5 w-5 text-purple-700" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-[14px] text-slate-800 dark:text-slate-100 truncate" title={customer.displayName}>
              {customer.displayName}
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-1.5 py-0.5 font-semibold text-purple-700">
                Customer
              </span>
              <span className="ml-2 tabular-nums">
                {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Contact list */}
      {contacts.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
          No contacts at this customer yet.
        </div>
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
