import { useState, useMemo, useEffect } from 'react';
import { Plus, Building2, User as UserIcon, Search, X, Upload, Mail, Phone, Pencil, FolderKanban } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { useDebounce } from '@/hooks/use-debounce';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { PartnerDrawer } from './partner-drawer';
import { CreateOrganizationModal } from './create-organization-modal';
import { CreateContactModal } from './create-contact-modal';
import { ImportCsvModal } from './import-csv-modal';

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
  outgoingRelationships: Array<{ targetType: string; targetId: number; relationshipType: { code: string; name: string } }>;
  user: { id: number; isActive: boolean; lastLoginAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

type Tab = 'organizations' | 'contacts';

const TABS: { key: Tab; label: string; icon: typeof Building2; description: string }[] = [
  { key: 'organizations', label: 'Organizations', icon: Building2,  description: 'Customers, suppliers, partner companies, municipalities' },
  { key: 'contacts',      label: 'Contacts',      icon: UserIcon,   description: 'People who work at one of your organizations — customer contacts, supplier workers' },
];

export function PartnersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = (searchParams.get('tab') as Tab) || 'organizations';
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.key === tabFromUrl) ? tabFromUrl : 'organizations');
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const debouncedSearch = useDebounce(search, 300);
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('partners', 'write');

  // Sync tab to URL so deep-links and the back button work.
  useEffect(() => {
    if (searchParams.get('tab') !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', tab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // URL → state: when the search params change externally (e.g. the sidebar
  // "Contacts" link navigates to /partners?tab=contacts while we're already
  // mounted on /partners), pick up the new tab. Without this the page stays
  // on its initial tab and the sidebar link looks broken.
  useEffect(() => {
    const fromUrl = (searchParams.get('tab') as Tab) || 'organizations';
    if (TABS.some((t) => t.key === fromUrl) && fromUrl !== tab) {
      setTab(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBpId]);

  // ─── Data fetch ───────────────────────────────────────────────────────────
  // Organizations: partner_type=organization (customers, suppliers, etc.)
  // Contacts:      partner_type=person, has worker_of relationship
  //                (i.e. someone who works at one of our organizations)
  const { data, isLoading } = useQuery({
    queryKey: ['business-partners', tab, debouncedSearch],
    queryFn: () =>
      client
        .get('/business-partners', {
          params: {
            partnerType: tab === 'organizations' ? 'organization' : 'person',
            search: debouncedSearch || undefined,
            perPage: 200,
          },
        })
        .then((r) => r.data?.data ?? r.data),
  });

  const partners: BusinessPartner[] = useMemo(() => {
    const raw = data?.data ?? data ?? [];
    return Array.isArray(raw) ? raw : [];
  }, [data]);

  const activeTab = TABS.find((t) => t.key === tab)!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partners"
        description="Organizations you work with, the contacts inside them, and your internal employees — all linked through Business Partner relationships."
        actions={
          canWrite && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowImport(true)}
                className="flex items-center gap-2 rounded-lg bg-white border border-slate-200 hover:border-slate-400 px-4 py-2 text-[13px] font-semibold text-slate-700"
              >
                <Upload className="h-4 w-4" />
                Import CSV
              </button>
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white"
              >
                <Plus className="h-4 w-4" />
                Add {activeTab.label.replace(/s$/, '')}
              </button>
            </div>
          )
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'border-b-2 px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors',
                tab === t.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab description */}
      <p className="text-[12px] text-slate-500 -mt-3">{activeTab.description}</p>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${activeTab.label.toLowerCase()}...`}
          className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-9 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : partners.length === 0 ? (
        <EmptyState
          icon={activeTab.icon}
          title={`No ${activeTab.label.toLowerCase()} yet`}
          description={
            tab === 'organizations' ? 'Add the first organization you work with — customers, suppliers, partner companies.' :
            tab === 'contacts'      ? 'Add a contact (a person who works at one of your organizations).' :
                                      'Add the first employee. They get a login account and an HR record.'
          }
        />
      ) : tab === 'organizations' ? (
        <OrganizationsList partners={partners} onSelect={setSelectedId} />
      ) : (
        <ContactsListLoader partners={partners} onSelect={setSelectedId} />
      )}

      {showAdd && tab === 'organizations' && (
        <CreateOrganizationModal
          onClose={() => setShowAdd(false)}
          onCreated={(id) => { setShowAdd(false); setSelectedId(id); }}
        />
      )}
      {showAdd && tab === 'contacts' && (
        <CreateContactModal
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
    <div ref={scrollRef} className="rounded-[14px] border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2 text-left font-semibold">Organization</th>
            <th className="px-4 py-2 text-left font-semibold">Main Role</th>
            <th className="px-4 py-2 text-left font-semibold">Email</th>
            <th className="px-4 py-2 text-left font-semibold w-32">Phone</th>
            <th className="px-4 py-2 text-center font-semibold w-20">Status</th>
          </tr>
        </thead>
        <tbody>
          {partners.map((bp) => (
            <tr key={bp.id} onClick={() => onSelect(bp.id)} className="border-t border-slate-100 hover:bg-blue-50/30 cursor-pointer">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-700 shrink-0">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <p className="font-medium text-slate-800 truncate">{bp.displayName}</p>
                </div>
              </td>
              <td className="px-4 py-2.5">
                <MainRoleBadge mainRole={bp.mainRoleType} />
              </td>
              <td className="px-4 py-2.5 text-slate-600 text-[12px]">{bp.email || '—'}</td>
              <td className="px-4 py-2.5 text-slate-600 text-[12px]">{bp.phone || '—'}</td>
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

function ContactsListLoader({ partners, onSelect }: { partners: BusinessPartner[]; onSelect: (id: number) => void }) {
  // Pull the org list once so we can resolve worker_of -> employer display name.
  // Cached for 5 minutes; opening a contact drawer reuses the same data.
  const { data: orgsData } = useQuery({
    queryKey: ['business-partners', 'organizations', 'all'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client
        .get('/business-partners', { params: { partnerType: 'organization', perPage: 500 } })
        .then((r) => r.data?.data ?? r.data),
  });
  const orgs: { id: number; displayName: string; companyName?: string | null }[] = useMemo(() => {
    const raw = orgsData?.data ?? orgsData ?? [];
    return Array.isArray(raw) ? raw : [];
  }, [orgsData]);
  const orgNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of orgs) m.set(o.id, o.displayName);
    return m;
  }, [orgs]);

  // The seeded "Internal" org represents your own company. People who
  // worker_of the Internal org are *internal employees*, not external
  // contacts. (Secondary safety net — see the primary rule below.)
  const internalOrgIds = useMemo(() => {
    const ids = new Set<number>();
    for (const o of orgs) {
      const isInternal = (o.companyName ?? '').toLowerCase() === 'internal'
        || (o.displayName ?? '').toLowerCase() === 'internal';
      if (isInternal) ids.add(o.id);
    }
    return ids;
  }, [orgs]);

  const externalContacts = useMemo(() => {
    return partners.filter((bp) => {
      // PRIMARY RULE: a person who has a login account IS an internal
      // employee — they belong in /people (HR), not the Contacts list.
      // This is what previously leaked: employees with no worker_of edge
      // slipped through. Identity = "has a User row", not "works_of Internal".
      if (bp.user) return false;

      // SECONDARY: also drop anyone explicitly working for the Internal org.
      if (internalOrgIds.size > 0) {
        const workerOf = bp.outgoingRelationships?.find(
          (r: any) => r.relationshipType?.code === 'worker_of' && r.targetType === 'organization',
        );
        if (workerOf && internalOrgIds.has(workerOf.targetId)) return false;
      }
      return true;
    });
  }, [partners, internalOrgIds]);

  return <ContactsList partners={externalContacts} onSelect={onSelect} orgNameById={orgNameById} />;
}

function ContactsList({
  partners,
  onSelect,
  orgNameById,
}: {
  partners: BusinessPartner[];
  onSelect: (id: number) => void;
  orgNameById: Map<number, string>;
}) {
  // The list is rendered as enhanced rows — a richer layout than the old flat
  // table: prominent avatar, two-line identity (name + role · employer),
  // stacked email/phone with icons, status pill, project-count badge, and an
  // explicit "edit" action button. Designed to read well at-a-glance and
  // surface more useful info without losing scannability.
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
      {partners.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-slate-400 italic">No contacts in this group.</div>
      )}
      {partners.map((bp) => {
        // Employer is whichever org the contact has an active worker_of
        // relationship with. Fallback to legacy companyName for older rows.
        const workerOf = bp.outgoingRelationships?.find(
          (r) => r.relationshipType?.code === 'worker_of' && r.targetType === 'organization',
        );
        const employerName = workerOf
          ? (orgNameById.get(workerOf.targetId) ?? `Organization #${workerOf.targetId}`)
          : (bp.companyName ?? null);
        const roleLabel = bp.mainRoleType?.name ?? null;
        const subline = [roleLabel, employerName].filter(Boolean).join(' · ');

        return (
          <div
            key={bp.id}
            onClick={() => onSelect(bp.id)}
            className="group flex items-center gap-4 px-4 py-3 hover:bg-blue-50/40 cursor-pointer transition-colors"
          >
            {/* Identity — avatar + name + role/employer subline. */}
            <div className="flex items-center gap-3 min-w-0 flex-[2]">
              <UserAvatar firstName={bp.firstName ?? ''} lastName={bp.lastName ?? ''} avatarUrl={null} size="md" />
              <div className="min-w-0">
                <p className="font-semibold text-[14px] text-slate-800 truncate">{bp.displayName}</p>
                {subline ? (
                  <p className="text-[12px] text-slate-500 truncate">{subline}</p>
                ) : (
                  <p className="text-[12px] text-slate-300 italic">no role set</p>
                )}
              </div>
            </div>

            {/* Contact info — email + phone, with icons, on stacked lines. */}
            <div className="hidden md:flex flex-col gap-0.5 flex-[2] min-w-0 text-[12px]">
              {bp.email ? (
                <a
                  href={`mailto:${bp.email}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 text-slate-700 hover:text-blue-700 truncate"
                  title={bp.email}
                >
                  <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{bp.email}</span>
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-slate-300">
                  <Mail className="h-3.5 w-3.5" /> —
                </span>
              )}
              {(bp.phone || bp.mobile) ? (
                <a
                  href={`tel:${bp.phone || bp.mobile}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 text-slate-700 hover:text-blue-700"
                >
                  <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="tabular-nums">{bp.phone || bp.mobile}</span>
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-slate-300">
                  <Phone className="h-3.5 w-3.5" /> —
                </span>
              )}
            </div>

            {/* Project count badge — placeholder zero until Phase-1b backend
                wire-up; the visual layout is final so adding the real number
                later is a one-line swap. */}
            <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-slate-600 shrink-0">
              <FolderKanban className="h-3.5 w-3.5 text-slate-400" />
              <span className="font-semibold tabular-nums">{(bp as any).projectCount ?? '—'}</span>
              <span className="text-slate-400">projects</span>
            </div>

            {/* Status pill (active / archived). */}
            <div className="shrink-0">
              <StatusBadge status={bp.status} />
            </div>

            {/* Actions — only the edit affordance for now; opens the drawer
                which already has full edit + delete. Visible on hover so the
                row stays calm at rest. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSelect(bp.id); }}
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-md p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
              title="Edit contact"
              aria-label="Edit contact"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
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
      <span className="text-[11px] text-slate-400 italic">not set</span>
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
      isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', isActive ? 'bg-emerald-500' : 'bg-slate-400')} />
      {status}
    </span>
  );
}
