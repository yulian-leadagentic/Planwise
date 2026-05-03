import { useState, useMemo, useEffect } from 'react';
import { Plus, Building2, User as UserIcon, Search, X, Upload } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { UserAvatar } from '@/components/shared/user-avatar';
import { EmptyState } from '@/components/shared/empty-state';
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
  roles: PartnerRoleSummary[];
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
        <ContactsList partners={partners} onSelect={setSelectedId} />
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
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2 text-left font-semibold">Organization</th>
            <th className="px-4 py-2 text-left font-semibold">Roles</th>
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
                <RoleChips roles={bp.roles} />
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

function ContactsList({ partners, onSelect }: { partners: BusinessPartner[]; onSelect: (id: number) => void }) {
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2 text-left font-semibold">Name</th>
            <th className="px-4 py-2 text-left font-semibold">Employer</th>
            <th className="px-4 py-2 text-left font-semibold">Roles</th>
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
                  <UserAvatar firstName={bp.firstName ?? ''} lastName={bp.lastName ?? ''} avatarUrl={null} size="sm" />
                  <p className="font-medium text-slate-800 truncate">{bp.displayName}</p>
                </div>
              </td>
              <td className="px-4 py-2.5 text-slate-600 text-[12px]">{bp.companyName || '—'}</td>
              <td className="px-4 py-2.5"><RoleChips roles={bp.roles} /></td>
              <td className="px-4 py-2.5 text-slate-600 text-[12px]">{bp.email || '—'}</td>
              <td className="px-4 py-2.5 text-slate-600 text-[12px]">{bp.phone || bp.mobile || '—'}</td>
              <td className="px-4 py-2.5 text-center"><StatusBadge status={bp.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tiny helpers ────────────────────────────────────────────────────────────

function RoleChips({ roles }: { roles: BusinessPartner['roles'] }) {
  if (roles.length === 0) return <span className="text-[11px] text-slate-400 italic">none</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span
          key={r.id}
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
            r.isPrimary ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600',
          )}
        >
          {r.roleType.name}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn(
      'rounded-full px-2 py-0.5 text-[10px] font-medium',
      status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500',
    )}>
      {status}
    </span>
  );
}
