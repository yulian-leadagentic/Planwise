import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useProject, useCreateProject, useUpdateProject, useProjectTypes } from '@/hooks/use-projects';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';

const projectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  number: z.string().optional(),
  description: z.string().optional(),
  projectTypeId: z.coerce.number().min(1, 'Please select a project type'),
  departmentId: z.preprocess((v) => (v === '' || v === 0 || v === '0' ? undefined : Number(v)), z.number().optional()),
  customerOrgId: z.coerce.number().min(1, 'Please pick a customer organization'),
  status: z.string().default('draft'),
  budget: z.coerce.number().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  leaderId: z.preprocess((v) => (v === '' || v === 0 || v === '0' ? undefined : Number(v)), z.number().optional()),
});

type ProjectFormData = z.infer<typeof projectSchema>;

const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';
const inputErrorClass =
  'w-full px-3 py-2.5 rounded-lg border border-red-400 text-sm text-slate-700 focus:border-red-500 focus:outline-none';
const labelClass = 'text-[13px] font-semibold text-slate-700 mb-1.5 block';
const sectionHeadingClass = 'text-[15px] font-bold text-slate-900';

export function ProjectFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;
  const projectId = Number(id);

  const { isAdmin } = usePermissions();
  // Only admins can change the customer of an existing project. For non-admins
  // the field stays locked (as before) — there are downstream invariants (BP
  // relationships, billing) we don't want random PMs reshuffling.
  const canChangeCustomer = !isEdit || isAdmin;

  const { data: project, isLoading: projectLoading } = useProject(isEdit ? projectId : 0);
  const { data: projectTypes } = useProjectTypes();
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    staleTime: 10 * 60 * 1000,
    queryFn: () => client.get('/admin/config/departments').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  // Customer organizations — orgs with the "customer" role. The seeded
  // "Internal" org is included for projects with no external customer.
  const { data: customers = [] } = useQuery<any[]>({
    queryKey: ['customer-orgs'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/business-partners?partnerType=organization&roleType=customer&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : (d?.data ?? []);
    }),
  });
  // M4a.2 — ProjectRoleType catalog. Any role flagged isPrimaryRequired
  // (other than 'customer', which has its own field above) becomes a
  // required picker on the create form. New role-types added in admin
  // surface here automatically.
  const { data: projectRoleTypes = [] } = useQuery<any[]>({
    queryKey: ['project-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/project-role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const requiredRoles = projectRoleTypes.filter(
    (rt: any) => rt.isPrimaryRequired && rt.code !== 'customer',
  );

  // Required-role assignments — { [roleId]: partyId }. The form blocks
  // submit until every required role has a pick.
  const [requiredRoleSelections, setRequiredRoleSelections] = useState<Record<number, number | null>>({});

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();

  // The `users` active-users query was here. Removed when the legacy
  // Project Leader dropdown was deleted — its only consumer. Team
  // Leader is now a ProjectRoleType, picked via RequiredRolePicker (or
  // from the Team tab post-create).

  // Team-member state + Team-template picker were here. Both removed
  // when team management moved to the Team tab. The project create
  // form no longer touches team membership — projects start empty and
  // members get added afterwards from the project detail page.

  // Optional quick link — Google Drive / network share / etc. Saved as a
  // ProjectFile of kind=link after the project is created/updated, so it's
  // visible in the existing Files tab.
  const [quickLinkUrl, setQuickLinkUrl] = useState('');
  const [quickLinkName, setQuickLinkName] = useState('');

  // Default end date is "open-ended" — projects without a known finish date
  // get 9999-12-31, matching how SAP-style time-bounded relationships use a
  // far-future sentinel. Users can pick a real date if they have one.
  const DEFAULT_OPEN_END_DATE = '9999-12-31';

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: { status: 'draft', endDate: DEFAULT_OPEN_END_DATE },
  });

  // For edit-mode: look up the project's current customer (relationship table).
  const { data: existingCustomerRel } = useQuery<any>({
    queryKey: ['project-customer', projectId],
    enabled: isEdit && !!projectId,
    queryFn: () => client.get('/business-partner-relationships', {
      params: { targetType: 'project', targetId: projectId, relationshipTypeCode: 'customer_of_project', activeOnly: true },
    }).then((r) => {
      const list = r.data?.data ?? r.data;
      const arr = Array.isArray(list) ? list : (list?.data ?? []);
      return arr[0] ?? null;
    }),
  });

  useEffect(() => {
    if (project && isEdit) {
      // Slice ISO timestamps to YYYY-MM-DD so <input type="date"> accepts them.
      const toDateInput = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');
      reset({
        name: project.name,
        number: project.number ?? '',
        description: project.description ?? '',
        projectTypeId: project.projectTypeId,
        departmentId: (project as any).departmentId ?? undefined,
        customerOrgId: existingCustomerRel?.sourcePartnerId ?? existingCustomerRel?.source?.id ?? undefined,
        status: project.status,
        budget: project.budget ?? undefined,
        startDate: toDateInput(project.startDate),
        // For pre-existing projects with no end date, fall back to the
        // far-future sentinel so the field is never empty.
        endDate: toDateInput(project.endDate) || DEFAULT_OPEN_END_DATE,
        leaderId: (project as any).leaderId ?? undefined,
      });
      // Member loading was here. Team is managed only from the Team
      // tab now — no need to seed the form with the existing list.
    }
  }, [project, isEdit, reset, existingCustomerRel]);

  if (isEdit && projectLoading) return <PageSkeleton />;

  // Helper: detect cloud-storage providers in a URL so we can give a sensible
  // default display name (mirrors the heuristic in files-tab.tsx).
  const detectProviderLabel = (url: string): string => {
    const u = url.toLowerCase();
    if (u.includes('drive.google.com') || u.includes('docs.google.com')) return 'Google Drive';
    if (u.includes('dropbox.com')) return 'Dropbox';
    if (u.includes('1drv.ms') || u.includes('onedrive.live.com')) return 'OneDrive';
    if (u.includes('sharepoint.com')) return 'SharePoint';
    return 'External link';
  };

  // After the project is saved, persist the optional quick-link as a
  // ProjectFile of kind=link. Best-effort: a failure surfaces a toast but
  // doesn't roll back the project save.
  const persistQuickLinkIfNeeded = async (savedProjectId: number) => {
    const url = quickLinkUrl.trim();
    if (!url) return;
    const name = quickLinkName.trim() || detectProviderLabel(url);
    try {
      await client.post(`/projects/${savedProjectId}/files/link`, { name, url });
    } catch (err: any) {
      notify.apiError(err, 'Project saved, but link could not be added');
    }
  };

  const onSubmit = (data: ProjectFormData) => {
    // memberIds intentionally NOT spread in — team management moved
    // to the Team tab. Project starts with no members; admins add
    // them after the project is created via the dedicated UI which
    // supports Project Role Types.
    const payload: any = { ...data };

    // Empty date strings would fail the API's @IsDateString() validator
    // and surface as cryptic "startDate must be a valid ISO 8601 date
    // string" errors. Drop them so @IsOptional skips the field entirely.
    if (!payload.startDate) delete payload.startDate;
    if (!payload.endDate) delete payload.endDate;
    if (!payload.budget && payload.budget !== 0) delete payload.budget;

    if (isEdit) {
      // customerOrgId isn't a column on Project — it's expressed as a
      // customer_of_project BP relationship. Strip it from the project PATCH;
      // when the admin actually changed it, swap the relationship below.
      const newCustomerOrgId = payload.customerOrgId;
      delete payload.customerOrgId;

      const oldCustomerOrgId = existingCustomerRel?.sourcePartnerId
        ?? existingCustomerRel?.source?.id
        ?? null;
      const customerChanged =
        canChangeCustomer && newCustomerOrgId && newCustomerOrgId !== oldCustomerOrgId;

      const swapCustomerIfNeeded = async () => {
        if (!customerChanged) return;
        // 1. End the current customer_of_project rel (soft-disconnect, preserves history).
        if (existingCustomerRel?.id) {
          await client.delete(`/business-partner-relationships/${existingCustomerRel.id}`)
            .catch(() => undefined);
        }
        // 2. Look up the relationship type id and create a new active rel.
        const relTypes = await client.get('/admin/partner-types/relationship-types')
          .then((r) => r.data?.data ?? r.data ?? []);
        const customerOfProject = (Array.isArray(relTypes) ? relTypes : []).find(
          (rt: any) => rt.code === 'customer_of_project',
        );
        if (!customerOfProject) {
          throw new Error('customer_of_project relationship type missing');
        }
        await client.post('/business-partner-relationships', {
          sourcePartnerId: newCustomerOrgId,
          targetType: 'project',
          targetId: projectId,
          relationshipTypeId: customerOfProject.id,
          isPrimary: true,
        });
      };

      updateProject.mutate(
        { id: projectId, ...payload },
        {
          onSuccess: async () => {
            try {
              await swapCustomerIfNeeded();
              if (customerChanged) notify.success('Customer reassigned', { code: 'PRJ-CUSTOMER-200' });
            } catch (err: any) {
              notify.apiError(err, 'Project saved, but customer reassignment failed');
            }
            await persistQuickLinkIfNeeded(projectId);
            navigate(`/projects/${projectId}`);
          },
        },
      );
    } else {
      // M4a.2 — Validate required-role selections before POST.
      const missing = requiredRoles.filter((rt: any) => !requiredRoleSelections[rt.id]);
      if (missing.length > 0) {
        notify.warning(
          `Missing required role${missing.length > 1 ? 's' : ''}: ${missing.map((r: any) => r.name).join(', ')}`,
          { code: 'PROJECT-CREATE-400' },
        );
        return;
      }
      // Build the roleAssignments payload from the picks. Each pick is
      // automatically isPrimary=true so it satisfies the server's
      // isPrimaryRequired check.
      const roleAssignments = requiredRoles
        .filter((rt: any) => requiredRoleSelections[rt.id])
        .map((rt: any) => ({
          roleId: rt.id,
          partyId: requiredRoleSelections[rt.id],
          isPrimary: true,
        }));
      if (roleAssignments.length) payload.roleAssignments = roleAssignments;

      createProject.mutate(payload, {
        onSuccess: async (created: any) => {
          await persistQuickLinkIfNeeded(created.id);
          navigate(`/projects/${created.id}`);
        },
      });
    }
  };

  const isPending = createProject.isPending || updateProject.isPending;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-[640px] mx-auto py-8 px-4">
        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-500 hover:text-slate-700 mb-5"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Page title */}
        <h1 className="text-xl font-bold tracking-tight text-slate-900 mb-6">
          {isEdit ? 'Edit Project' : 'New Project'}
        </h1>

        <form onSubmit={handleSubmit(onSubmit)}>
          {/* Validation error banner */}
          {Object.keys(errors).length > 0 && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-700 mb-1">Please fix the following errors:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {Object.entries(errors).map(([field, error]) => (
                  <li key={field} className="text-sm text-red-600">{(error as any)?.message || `${field} is invalid`}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-white rounded-[14px] border border-slate-200">
            {/* Section 1: Project Details */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>PROJECT DETAILS</h2>

              <div className="mt-4 grid grid-cols-2 gap-4">
                {/* Project Name */}
                <div>
                  <label className={labelClass}>
                    Project Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    {...register('name')}
                    placeholder="Enter project name"
                    className={errors.name ? inputErrorClass : inputClass}
                  />
                  {errors.name && (
                    <p className="mt-1 text-[12px] text-red-500">{errors.name.message}</p>
                  )}
                </div>

                {/* Project Number */}
                <div>
                  <label className={labelClass}>Project Number</label>
                  <input
                    {...register('number')}
                    placeholder="e.g. PRJ-001"
                    className={inputClass}
                  />
                </div>

                {/* Project Type with color indicator */}
                <div>
                  <label className={labelClass}>
                    Project Type <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    {(() => {
                      const selectedId = watch('projectTypeId');
                      const selectedType = (projectTypes ?? []).find((t: any) => String(t.id) === String(selectedId));
                      const color = selectedType?.color;
                      return color ? (
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-slate-200 z-10"
                          style={{ backgroundColor: color.startsWith('#') ? color : `#${color}` }} />
                      ) : null;
                    })()}
                    <select
                      {...register('projectTypeId')}
                      className={`${errors.projectTypeId ? inputErrorClass : inputClass} ${watch('projectTypeId') ? 'pl-8' : ''}`}
                    >
                      <option value="">Select type</option>
                      {(projectTypes ?? []).map((t: any) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {errors.projectTypeId && (
                    <p className="mt-1 text-[12px] text-red-500">{errors.projectTypeId.message}</p>
                  )}
                </div>

                {/* Department */}
                <div>
                  <label className={labelClass}>Department</label>
                  <select {...register('departmentId')} className={inputClass}>
                    <option value="">Select department</option>
                    {(departments as any[]).map((d: any) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>

                {/* Customer (required at create; locked in edit mode) */}
                <div>
                  <label className={labelClass}>
                    Customer <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register('customerOrgId')}
                    disabled={!canChangeCustomer}
                    className={`${errors.customerOrgId ? inputErrorClass : inputClass} ${!canChangeCustomer ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                  >
                    <option value="">Select customer organization</option>
                    {customers.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName}
                        {c.companyName === 'Internal' ? ' (internal projects)' : ''}
                      </option>
                    ))}
                  </select>
                  {errors.customerOrgId && (
                    <p className="mt-1 text-[12px] text-red-500">{errors.customerOrgId.message}</p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-400">
                    {!isEdit ? (
                      <>Need a new customer? Add it from <a href="/partners?tab=organizations" className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">Partners → Organizations</a> first.</>
                    ) : isAdmin ? (
                      'Saving will end the previous customer-of-project relationship and start a new one (history is preserved).'
                    ) : (
                      'Customer is locked after project creation — only an admin can reassign it.'
                    )}
                  </p>
                </div>

                {/* Required project-role pickers used to live here. They
                    moved to the TEAM section so all people-on-the-project
                    fields (Project Leader + BIM Leader / Architect /
                    Engineer / etc.) sit in one place — per user request. */}

                {/* Status */}
                <div>
                  <label className={labelClass}>Status</label>
                  <select {...register('status')} className={inputClass}>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="on_hold">On Hold</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200" />

            {/* Section 2: Budget & Schedule */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>BUDGET & SCHEDULE</h2>

              <div className="mt-4 grid grid-cols-3 gap-4">
                {/* Budget */}
                <div>
                  <label className={labelClass}>Budget</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                      &#8362;
                    </span>
                    <input
                      {...register('budget')}
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      className="w-full pl-7 pr-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Start Date */}
                <div>
                  <label className={labelClass}>Start Date</label>
                  <input {...register('startDate')} type="date" className={inputClass} />
                </div>

                {/* End Date */}
                <div>
                  <label className={labelClass}>End Date</label>
                  <input {...register('endDate')} type="date" className={inputClass} />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Defaults to <code>9999-12-31</code> (open-ended) — set a real date when the project has a known finish.
                  </p>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200" />

            {/* Section 3: Team */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>TEAM</h2>

              <div className="mt-4 flex flex-col gap-4">
                {/* The legacy "Project Leader" dropdown was removed —
                    Team Leader is now just another Project Role Type
                    (system-seeded as `team_leader`). To require it on
                    every project, mark it isPrimaryRequired=true in
                    Admin → Project Role Types and it'll show up as one
                    of the RequiredRolePicker fields below. */}

                {/* Required project-role pickers — one field per
                    ProjectRoleType where isPrimaryRequired=true (excluding
                    'customer', which has its own picker above). The TEAM
                    section gathers all people-on-the-project fields so
                    BIM Leader / Architect / etc. sit together. */}
                {!isEdit && requiredRoles.map((rt: any) => (
                  <RequiredRolePicker
                    key={rt.id}
                    role={rt}
                    value={requiredRoleSelections[rt.id] ?? null}
                    onChange={(v) =>
                      setRequiredRoleSelections((prev) => ({ ...prev, [rt.id]: v }))
                    }
                  />
                ))}

                {/* Other team members are managed from the Team tab on
                    the project detail page — keeping the create flow
                    focused on the required people. */}
                <p className="text-[11px] text-slate-400 italic">
                  Additional team members are managed from the project's <strong>Team</strong> tab after the project is created.
                </p>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200" />

            {/* Section 4: Description */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>DESCRIPTION</h2>

              <div className="mt-4">
                <textarea
                  {...register('description')}
                  rows={3}
                  placeholder="Add a project description..."
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none resize-none"
                />
              </div>

              {/* Optional quick link — single full-width URL field, with the
                  optional "Display name" tucked away as a small expander so it
                  doesn't dominate the form. Auto-detects the provider and uses
                  it as the default display name when one isn't typed. Stored
                  as a ProjectFile of kind=link, visible in the Files tab. */}
              <QuickLinkBlock
                url={quickLinkUrl}
                name={quickLinkName}
                onChangeUrl={setQuickLinkUrl}
                onChangeName={setQuickLinkName}
                detectProviderLabel={detectProviderLabel}
                inputClass={inputClass}
                labelClass={labelClass}
              />
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200" />

            {/* Footer buttons */}
            <div className="p-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-2"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {isEdit ? 'Update Project' : 'Create Project'}
              </button>
            </div>
          </div>
        </form>

        {/* Team Template Picker Modal was here — removed alongside
            the Team Members inline block. Team templates can still be
            applied from the project's Team tab where they belong. */}
      </div>
    </div>
  );
}

/* ─── Quick Link block ─────────────────────────────────────────────────────────
   Cleaner than the previous side-by-side fields. The URL is the primary
   input (full width); the optional Display name is hidden by default and
   only revealed via a small "Add a custom name…" toggle. When no custom
   name is set, the saved link's name falls back to the auto-detected
   provider ("Google Drive") so users don't have to think about it.
*/
function QuickLinkBlock({
  url,
  name,
  onChangeUrl,
  onChangeName,
  detectProviderLabel,
  inputClass,
  labelClass,
}: {
  url: string;
  name: string;
  onChangeUrl: (v: string) => void;
  onChangeName: (v: string) => void;
  detectProviderLabel: (u: string) => string;
  inputClass: string;
  labelClass: string;
}) {
  const [showName, setShowName] = useState(!!name.trim());
  const provider = url.trim() ? detectProviderLabel(url.trim()) : null;
  const isCloud = provider && provider !== 'External link';

  return (
    <div className="mt-5">
      <label className={labelClass}>Quick link (optional)</label>
      <p className="text-[12px] text-slate-500 mb-2">
        Paste a Google Drive folder, network share, or external URL so the team has it on day one.
        More links can be added later from the Files tab.
      </p>
      <input
        type="text"
        value={url}
        onChange={(e) => onChangeUrl(e.target.value)}
        placeholder="https://drive.google.com/drive/folders/...   or   \server\share\..."
        className={`${inputClass} font-mono text-[12px]`}
      />
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className="text-slate-500">
          {isCloud
            ? <>Detected as <span className="font-semibold">{provider}</span> — that'll be the saved name unless you set one below.</>
            : url.trim()
              ? 'Will be saved as a "Link" file you can open from the Files tab.'
              : <>&nbsp;</>}
        </span>
        {!showName && (
          <button
            type="button"
            onClick={() => setShowName(true)}
            className="text-blue-600 hover:text-blue-700 font-semibold"
          >
            + Custom display name
          </button>
        )}
      </div>
      {showName && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={isCloud ? `e.g. "${provider} folder"` : 'Display name shown in the Files tab'}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => { onChangeName(''); setShowName(false); }}
            className="text-[11px] text-slate-500 hover:text-slate-700"
            title="Hide custom name; default to the provider"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Required Role Picker ──────────────────────────────────────────────────
   One field per ProjectRoleType.isPrimaryRequired=true row. Fetches eligible
   parties filtered by allowedPartnerKind + requiredPartnerRoleCode. Empty
   list yields an inline note pointing to where to create such a party. */

function RequiredRolePicker({
  role,
  value,
  onChange,
}: {
  role: {
    id: number;
    name: string;
    code: string;
    allowedPartnerKind: 'person' | 'organization' | 'any';
    requiredPartnerRoleCode: string | null;
    description: string | null;
  };
  value: number | null;
  onChange: (partyId: number | null) => void;
}) {
  const { data: candidates = [] } = useQuery<any[]>({
    queryKey: ['required-role-candidates', role.id],
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: role.allowedPartnerKind === 'any' ? undefined : role.allowedPartnerKind,
          roleType: role.requiredPartnerRoleCode ?? undefined,
          perPage: 500,
        },
      }).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });

  return (
    <div>
      <label className={labelClass}>
        {role.name} <span className="text-red-500">*</span>
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className={inputClass}
      >
        <option value="">Select {role.name.toLowerCase()}…</option>
        {candidates.map((c: any) => (
          <option key={c.id} value={c.id}>{c.displayName}</option>
        ))}
      </select>
      {candidates.length === 0 ? (
        <p className="mt-1 text-[11px] text-amber-700">
          No eligible {role.allowedPartnerKind === 'any' ? 'parties' : `${role.allowedPartnerKind}s`}
          {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''}
          . Add one from <a href="/partners" className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">Partners</a> first.
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-slate-400">
          {role.description || `Required for project creation (admin configured ${role.name} as required).`}
        </p>
      )}
    </div>
  );
}
