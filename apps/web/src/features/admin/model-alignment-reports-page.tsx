import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Database,
  FileText,
  Network,
  Users as UsersIcon,
} from 'lucide-react';

import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/loading-skeleton';

/**
 * People-model-alignment §9 — Phase 4 pre-migration verification.
 *
 * Four independent read-only reports mirrored 1:1 from the endpoints in
 * `admin/reports.controller.ts`. Yulian reviews outliers here BEFORE
 * approving each stage's migration commit. Nothing on this page writes
 * to the database; the "Copy JSON" button dumps the raw response so a
 * follow-up can be scripted from the same payload the UI showed.
 */

// ─── Response shapes (mirror the controller exactly) ─────────────────

interface Stage1Response {
  homeOrgId: number | null;
  homeDomains: string[];
  employeesOffHomeDomain: Array<{
    userId: number;
    email: string | null;
    name: string;
    userType: string;
    seniorityLevelId: number | null;
    isActive: boolean;
  }>;
  onHomeDomainNotEmployee: Array<{
    userId: number;
    email: string | null;
    name: string;
    userType: string;
  }>;
}

interface Stage2Response {
  userDepartments: Array<{
    department: string;
    userCount: number;
    matchingOrgUnitId: number | null;
    matchingOrgUnitName: string | null;
  }>;
  projectDepartments: Array<{
    departmentId: number;
    departmentName: string | null;
    projectCount: number;
    matchingOrgUnitId: number | null;
  }>;
}

interface Stage3Response {
  contractsWithPartnerUser: Array<{
    contractId: number;
    contractCode: string | null;
    partnerUserId: number;
    partnerUserName: string;
    partnerBusinessPartnerId: number | null;
  }>;
  contractsWithoutPartnerBp: Array<{
    contractId: number;
    contractCode: string | null;
    partnerUserId: number;
    partnerUserName: string;
    reason: string;
  }>;
}

interface Stage4Response {
  // Retirement (2026-09-28) — free-text `role` gone; every row is now
  // pinned to a catalog ProjectRoleType or null (→ D9 "Team member").
  memberRoleTypes: Array<{
    matchedProjectRoleTypeId: number;
    matchedProjectRoleTypeName: string | null;
    matchedProjectRoleTypeCode: string | null;
    memberCount: number;
  }>;
  nullOrEmpty: number;
}

// ─── Copy-to-clipboard helper ────────────────────────────────────────

async function copyJson(label: string, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback path — the modern API isn't available on http:// hosts
      // inside iframes and on some Firefox setups. A textarea + execCommand
      // still works everywhere the app runs today (staging is HTTPS but
      // /admin/reports/* is dev-navigable via localhost).
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    notify.success(`Copied ${label} JSON to clipboard`);
  } catch (err) {
    notify.error(`Could not copy ${label} JSON`);
    console.warn('[model-alignment-reports] copy failed', err);
  }
}

// ─── Card shell used by every stage ──────────────────────────────────

interface StageCardProps {
  index: number;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  isLoading: boolean;
  isError: boolean;
  data: unknown;
  counts: Array<{ label: string; value: number; tone?: 'ok' | 'warn' }>;
  children: React.ReactNode;
}

function StageCard({
  index,
  title,
  subtitle,
  icon: Icon,
  isLoading,
  isError,
  data,
  counts,
  children,
}: StageCardProps) {
  const [open, setOpen] = useState(true);
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 dark:border-slate-700',
        'bg-white dark:bg-slate-900 shadow-sm',
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-700 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="flex flex-col">
            <span className="flex items-center gap-2">
              <span className="text-xs font-mono uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Stage {index}
              </span>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {title}
              </span>
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</span>
          </span>
          <span aria-hidden="true" className="ml-auto text-slate-400 dark:text-slate-500">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {counts.map((c) => (
              <span
                key={c.label}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  c.tone === 'warn' && c.value > 0
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
                )}
              >
                <span className="font-mono tabular-nums">{c.value}</span>{' '}
                <span className="opacity-80">{c.label}</span>
              </span>
            ))}
          </div>
          <button
            type="button"
            disabled={isLoading || isError || !data}
            onClick={() => copyJson(`Stage ${index}`, data)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200',
              'hover:bg-slate-50 dark:hover:bg-slate-800/60',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
            Copy JSON
          </button>
        </div>
      </header>
      {open && (
        <div className="px-4 py-4">
          {isLoading ? (
            <TableSkeleton rows={4} cols={4} />
          ) : isError ? (
            <div className="flex items-center gap-2 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-200">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Failed to load Stage {index} report. Retry from the reload button in the header.
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}

// ─── Stage 1 ─────────────────────────────────────────────────────────

function Stage1Card() {
  const q = useQuery<Stage1Response>({
    queryKey: ['admin', 'model-alignment', 'stage-1'],
    queryFn: () =>
      client
        .get('/admin/reports/model-alignment/stage-1-usertype-vs-domain')
        // ResponseInterceptor on the API wraps payloads as
        // { success: true, data: <payload> }; unwrap defensively so the
        // page still works if a future call site returns raw payloads.
        .then((r) => r.data?.data ?? r.data),
  });

  const offDomainCols = useMemo<ColumnDef<Stage1Response['employeesOffHomeDomain'][number], unknown>[]>(() => [
    { accessorKey: 'userId', header: 'User ID', cell: ({ row }) => <span className="font-mono text-xs">#{row.original.userId}</span> },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'email', header: 'Email', cell: ({ row }) => row.original.email ?? '—' },
    { accessorKey: 'userType', header: 'Type', cell: ({ row }) => (
      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-mono">
        {row.original.userType}
      </span>
    )},
    { accessorKey: 'isActive', header: 'Active', cell: ({ row }) => (
      <span className={cn('text-xs', row.original.isActive
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-slate-500 dark:text-slate-400')}>
        {row.original.isActive ? 'Yes' : 'No'}
      </span>
    )},
  ], []);

  const onDomainCols = useMemo<ColumnDef<Stage1Response['onHomeDomainNotEmployee'][number], unknown>[]>(() => [
    { accessorKey: 'userId', header: 'User ID', cell: ({ row }) => <span className="font-mono text-xs">#{row.original.userId}</span> },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'email', header: 'Email', cell: ({ row }) => row.original.email ?? '—' },
    { accessorKey: 'userType', header: 'Type', cell: ({ row }) => (
      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-mono">
        {row.original.userType}
      </span>
    )},
  ], []);

  const data = q.data;
  return (
    <StageCard
      index={1}
      title="Type vs. home-domain drift"
      subtitle="Employees off the home domain, and home-domain logins that are not Employees."
      icon={UsersIcon}
      isLoading={q.isLoading}
      isError={q.isError}
      data={data}
      counts={[
        { label: 'off-domain Employees', value: data?.employeesOffHomeDomain.length ?? 0, tone: 'warn' },
        { label: 'home-domain non-Employees', value: data?.onHomeDomainNotEmployee.length ?? 0, tone: 'warn' },
      ]}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
          Home organization:{' '}
          {data?.homeOrgId != null ? (
            <span className="font-mono">BP #{data.homeOrgId}</span>
          ) : (
            <span className="italic text-amber-700 dark:text-amber-300">not configured</span>
          )}
          {' · '}
          Home domains:{' '}
          {(data?.homeDomains?.length ?? 0) === 0 ? (
            <span className="italic text-amber-700 dark:text-amber-300">none</span>
          ) : (
            data!.homeDomains.map((d) => (
              <span key={d} className="mr-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 font-mono text-[11px]">{d}</span>
            ))
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Employees off the home domain
          </h3>
          {(data?.employeesOffHomeDomain.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="Nothing to review"
              description="Every Employee record sits on a home-org domain."
            />
          ) : (
            <DataTable columns={offDomainCols} data={data!.employeesOffHomeDomain} pageSize={10} />
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Home-domain logins that are not Employees
          </h3>
          {(data?.onHomeDomainNotEmployee.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="Nothing to review"
              description="Every home-domain login is already an Employee."
            />
          ) : (
            <DataTable columns={onDomainCols} data={data!.onHomeDomainNotEmployee} pageSize={10} />
          )}
        </div>
      </div>
    </StageCard>
  );
}

// ─── Stage 2 ─────────────────────────────────────────────────────────

function Stage2Card() {
  const q = useQuery<Stage2Response>({
    queryKey: ['admin', 'model-alignment', 'stage-2'],
    queryFn: () =>
      client
        .get('/admin/reports/model-alignment/stage-2-department-mapping')
        .then((r) => r.data?.data ?? r.data),
  });
  const data = q.data;

  const userDeptCols = useMemo<ColumnDef<Stage2Response['userDepartments'][number], unknown>[]>(() => [
    { accessorKey: 'department', header: 'Department (User string)' },
    { accessorKey: 'userCount', header: '# Users',
      cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.userCount}</span> },
    { id: 'match', header: 'Matching Organization Unit',
      cell: ({ row }) => row.original.matchingOrgUnitId == null
        ? <span className="text-amber-700 dark:text-amber-300">— no match —</span>
        : (
          <span className="text-slate-700 dark:text-slate-200">
            {row.original.matchingOrgUnitName}
            <span className="ml-1 text-xs text-slate-500 dark:text-slate-400 font-mono">#{row.original.matchingOrgUnitId}</span>
          </span>
        ) },
  ], []);

  const projDeptCols = useMemo<ColumnDef<Stage2Response['projectDepartments'][number], unknown>[]>(() => [
    { accessorKey: 'departmentId', header: 'Department ID',
      cell: ({ row }) => <span className="font-mono text-xs">#{row.original.departmentId}</span> },
    { accessorKey: 'departmentName', header: 'Name',
      cell: ({ row }) => row.original.departmentName ?? <span className="italic text-slate-500">null</span> },
    { accessorKey: 'projectCount', header: '# Projects',
      cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.projectCount}</span> },
    { id: 'match', header: 'Matching Organization Unit',
      cell: ({ row }) => row.original.matchingOrgUnitId == null
        ? <span className="text-amber-700 dark:text-amber-300">— no match —</span>
        : <span className="font-mono text-xs text-slate-700 dark:text-slate-200">#{row.original.matchingOrgUnitId}</span> },
  ], []);

  const unmatchedUsers = data?.userDepartments.filter((r) => r.matchingOrgUnitId == null).length ?? 0;
  const unmatchedProjects = data?.projectDepartments.filter((r) => r.matchingOrgUnitId == null).length ?? 0;

  return (
    <StageCard
      index={2}
      title="Department → Organization Unit mapping"
      subtitle="Every distinct department string / id and the OrgUnit it would land on."
      icon={Network}
      isLoading={q.isLoading}
      isError={q.isError}
      data={data}
      counts={[
        { label: 'User departments', value: data?.userDepartments.length ?? 0 },
        { label: 'User dept unmatched', value: unmatchedUsers, tone: 'warn' },
        { label: 'Project departments', value: data?.projectDepartments.length ?? 0 },
        { label: 'Project dept unmatched', value: unmatchedProjects, tone: 'warn' },
      ]}
    >
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            User.department strings
          </h3>
          {(data?.userDepartments.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No department strings"
              description="Nobody carries a legacy User.department string."
            />
          ) : (
            <DataTable columns={userDeptCols} data={data!.userDepartments} pageSize={10} />
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Project.departmentId references
          </h3>
          {(data?.projectDepartments.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No project departments"
              description="No project points at a legacy Department row."
            />
          ) : (
            <DataTable columns={projDeptCols} data={data!.projectDepartments} pageSize={10} />
          )}
        </div>
      </div>
    </StageCard>
  );
}

// ─── Stage 3 ─────────────────────────────────────────────────────────

function Stage3Card() {
  const q = useQuery<Stage3Response>({
    queryKey: ['admin', 'model-alignment', 'stage-3'],
    queryFn: () =>
      client
        .get('/admin/reports/model-alignment/stage-3-contracts-partners')
        .then((r) => r.data?.data ?? r.data),
  });
  const data = q.data;

  const allCols = useMemo<ColumnDef<Stage3Response['contractsWithPartnerUser'][number], unknown>[]>(() => [
    { accessorKey: 'contractId', header: 'Contract',
      cell: ({ row }) => <span className="font-mono text-xs">#{row.original.contractId}</span> },
    { accessorKey: 'contractCode', header: 'Name / Code',
      cell: ({ row }) => row.original.contractCode ?? '—' },
    { accessorKey: 'partnerUserName', header: 'Partner (User)' },
    { accessorKey: 'partnerBusinessPartnerId', header: 'BP link',
      cell: ({ row }) => row.original.partnerBusinessPartnerId == null
        ? <span className="text-amber-700 dark:text-amber-300">— missing —</span>
        : <span className="font-mono text-xs text-slate-700 dark:text-slate-200">BP #{row.original.partnerBusinessPartnerId}</span> },
  ], []);

  const missingCols = useMemo<ColumnDef<Stage3Response['contractsWithoutPartnerBp'][number], unknown>[]>(() => [
    { accessorKey: 'contractId', header: 'Contract',
      cell: ({ row }) => <span className="font-mono text-xs">#{row.original.contractId}</span> },
    { accessorKey: 'contractCode', header: 'Name / Code',
      cell: ({ row }) => row.original.contractCode ?? '—' },
    { accessorKey: 'partnerUserName', header: 'Partner (User)' },
    { accessorKey: 'reason', header: 'Reason',
      cell: ({ row }) => (
        <span className="rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200 px-2 py-0.5 text-[11px] font-mono">
          {row.original.reason}
        </span>
      ) },
  ], []);

  return (
    <StageCard
      index={3}
      title="Contracts → Organization readiness"
      subtitle="Every contract with its partner User; rows whose User has no attached Business Partner."
      icon={FileText}
      isLoading={q.isLoading}
      isError={q.isError}
      data={data}
      counts={[
        { label: 'contracts', value: data?.contractsWithPartnerUser.length ?? 0 },
        { label: 'without BP', value: data?.contractsWithoutPartnerBp.length ?? 0, tone: 'warn' },
      ]}
    >
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Contracts without a Business-Partner link (blockers)
          </h3>
          {(data?.contractsWithoutPartnerBp.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="All contracts resolve to a Business Partner"
              description="Stage 3 migration can proceed once approved."
            />
          ) : (
            <DataTable columns={missingCols} data={data!.contractsWithoutPartnerBp} pageSize={10} />
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            All contracts with their current partner-User → BP link
          </h3>
          {(data?.contractsWithPartnerUser.length ?? 0) === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No contracts"
              description="Nothing in the contracts table to review."
            />
          ) : (
            <DataTable columns={allCols} data={data!.contractsWithPartnerUser} pageSize={10} />
          )}
        </div>
      </div>
    </StageCard>
  );
}

// ─── Stage 4 ─────────────────────────────────────────────────────────

function Stage4Card() {
  const q = useQuery<Stage4Response>({
    queryKey: ['admin', 'model-alignment', 'stage-4'],
    queryFn: () =>
      client
        .get('/admin/reports/model-alignment/stage-4-template-role-mapping')
        .then((r) => r.data?.data ?? r.data),
  });
  const data = q.data;

  const cols = useMemo<ColumnDef<Stage4Response['memberRoleTypes'][number], unknown>[]>(() => [
    { id: 'match', header: 'Project Role Type',
      cell: ({ row }) => (
        <span className="text-slate-700 dark:text-slate-200">
          {row.original.matchedProjectRoleTypeName ?? '—'}
          <span className="ml-1 text-xs text-slate-500 dark:text-slate-400 font-mono">#{row.original.matchedProjectRoleTypeId}</span>
          {row.original.matchedProjectRoleTypeCode && (
            <span className="ml-2 rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-mono text-slate-600 dark:text-slate-300">
              {row.original.matchedProjectRoleTypeCode}
            </span>
          )}
        </span>
      ) },
    { accessorKey: 'memberCount', header: '# Members',
      cell: ({ row }) => <span className="font-mono tabular-nums">{row.original.memberCount}</span> },
  ], []);

  return (
    <StageCard
      index={4}
      title="Team Template members → Project Role Types"
      subtitle="Distribution of catalog Project Role assignments across Team Template members."
      icon={Database}
      isLoading={q.isLoading}
      isError={q.isError}
      data={data}
      counts={[
        { label: 'distinct role types', value: data?.memberRoleTypes.length ?? 0 },
        { label: 'null / empty members', value: data?.nullOrEmpty ?? 0 },
      ]}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
          Members with no Project Role will land as{' '}
          <span className="rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 font-mono text-[11px]">Team member</span>
          {' '}per D9.
        </div>
        {(data?.memberRoleTypes.length ?? 0) === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No assigned Project Roles"
            description="Every Team Template member is roleless (D9 default applies)."
          />
        ) : (
          <DataTable columns={cols} data={data!.memberRoleTypes} pageSize={10} />
        )}
      </div>
    </StageCard>
  );
}

// ─── Page shell ──────────────────────────────────────────────────────

export function ModelAlignmentReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Alignment (§9)"
        description="Phase 4 pre-migration verification reports. Review outliers before authorizing each Stage."
      />
      <div className="space-y-4">
        <Stage1Card />
        <Stage2Card />
        <Stage3Card />
        <Stage4Card />
      </div>
    </div>
  );
}
