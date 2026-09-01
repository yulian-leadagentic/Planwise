import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { useProject, useCreateProject, useUpdateProject, useProjectTypes } from '@/hooks/use-projects';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { PeopleMultiSelect, type Person } from '@/components/shared/people-multi-select';

// Empty-string → undefined preprocessor. Lets `.optional()` pass for
// blank fields without z.coerce.number() turning '' into NaN and
// triggering "Expected number, received nan" (a default zod message
// that means nothing to end users).
const optionalNumber = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number({ invalid_type_error: 'Must be a number' }).optional(),
);

const projectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  number: z.string().optional(),
  description: z.string().optional(),
  projectTypeId: z.coerce.number().min(1, 'Please select a project category'),
  departmentId: optionalNumber,
  customerOrgId: z.coerce.number().min(1, 'Please pick a customer organization'),
  status: z.string().default('draft'),
  // Was z.coerce.number().optional() — empty input coerces to NaN
  // before .optional() can save it. Use the preprocess wrapper so an
  // unfilled Budget stays valid.
  budget: optionalNumber,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  // Free-text authoring tool version (e.g. "Revit 2024.2"). Editable
  // both at create time and from the Project Info tab.
  authoringToolVersion: z.string().optional(),
  // leaderId stays in the schema for back-compat with edit-mode forms
  // that still send the field; the dropdown was removed but Project
  // Leader is now a ProjectRoleType assignment via TeamRolePicker.
  leaderId: optionalNumber,
});

// Map schema field names to human labels for the error banner. zod's
// default error refers to fields by their property name ("budget",
// "projectTypeId") which is debugging-friendly but user-hostile.
const FIELD_LABELS: Record<string, string> = {
  name: 'Project Name',
  number: 'Project Number',
  projectTypeId: 'Project Category',
  departmentId: 'Department',
  customerOrgId: 'Customer',
  status: 'Status',
  budget: 'Budget',
  startDate: 'Start Date',
  endDate: 'End Date',
  authoringToolVersion: 'Authoring Tool Version',
  leaderId: 'Team Leader',
};

type ProjectFormData = z.infer<typeof projectSchema>;

const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none';
const inputErrorClass =
  'w-full px-3 py-2.5 rounded-lg border border-red-400 text-sm text-slate-700 dark:text-slate-200 focus:border-red-500 focus:outline-none';
const labelClass = 'text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block';
const sectionHeadingClass = 'text-[15px] font-bold text-slate-900 dark:text-slate-100';

export function ProjectFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;
  const projectId = Number(id);

  const { isAdmin, can } = usePermissions();
  // Only admins can change the customer of an existing project. For non-admins
  // the field stays locked (as before) — there are downstream invariants (BP
  // relationships, billing) we don't want random PMs reshuffling.
  const canChangeCustomer = !isEdit || isAdmin;
  // Same finance gate used everywhere else (Cost tab, project list Budget
  // column, project detail header). Non-finance users can't see or set the
  // project budget — the input is hidden entirely.
  const showFinance = can('finance', 'read');

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
  // How the Project Number field should behave, driven by the number range
  // assigned to the PROJECT entity kind (Admin → Object Numbering):
  //   • auto     → system-assigned, field is read-only (shows the next code).
  //   • manual/external → user must type a code (validated server-side).
  //   • none     → free text (legacy behavior).
  const { data: numberConfig } = useQuery<{
    assigned: boolean;
    mode: 'auto' | 'manual' | 'external' | null;
    preview: string | null;
    externalPattern: string | null;
  }>({
    queryKey: ['project-number-config'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/projects/number-config').then((r) => r.data?.data ?? r.data),
  });
  const numberMode = numberConfig?.mode ?? null;

  // ProjectRoleType catalog. The Team section on the New-Project form
  // used to render one stacked <select> per role-type (excluding
  // 'customer', which has its own field above). QA3 Commit B replaces
  // that long, mostly-empty column with a compact "+ Add role" picker:
  // the user picks a role and a person, and a chip-row lands in the
  // list. Every role is still OPTIONAL at create time (PR-023): zero
  // assignments is a valid submit, and admins can fill in more from
  // the project's Team tab afterwards. `isPrimaryRequired` still
  // governs the "obligatory roles" grouping there, not the create
  // form.
  const { data: projectRoleTypes = [] } = useQuery<any[]>({
    queryKey: ['project-role-types'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/project-role-types').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
  const teamRoles = useMemo(
    () => projectRoleTypes.filter((rt: any) => rt.code !== 'customer'),
    [projectRoleTypes],
  );

  // Team assignments the user has queued up before submit. Each row is
  // { tempId, roleId, partyId } — the tempId is a client-side stable key
  // (uuid-ish) so React survives adds/removes cleanly, and the same role
  // can appear more than once when the model allows it (different people
  // in the same role). Dedupe on (roleId, partyId) — a pair is unique per
  // ProjectPartnerRole's @@unique([projectId, partyId, roleId, validFrom]).
  const [teamAssignments, setTeamAssignments] = useState<
    Array<{ tempId: string; roleId: number; partyId: number }>
  >([]);

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();

  // The `users` active-users query was here. Removed when the legacy
  // Project Leader dropdown was deleted — its only consumer. Team
  // Leader is now a ProjectRoleType, picked via TeamRolePicker (or
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

  // For edit-mode: look up the project's current customer.
  // BM2 ops-surfaces Phase A: project participation lives on
  // /project-partner-roles now, keyed by ProjectRoleType.code='customer'.
  const { data: existingCustomerRel } = useQuery<any>({
    queryKey: ['project-customer', projectId],
    enabled: isEdit && !!projectId,
    queryFn: () => client.get('/project-partner-roles', {
      params: { projectId, roleCode: 'customer', activeOnly: true },
    }).then((r) => {
      const list = r.data?.data ?? r.data;
      const arr = Array.isArray(list) ? list : (list?.data ?? []);
      // Pick the primary customer (the write path marks the customer row
      // isPrimary=true; there should be at most one active primary).
      return arr.find((x: { isPrimary?: boolean }) => x.isPrimary) ?? arr[0] ?? null;
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
        customerOrgId: existingCustomerRel?.partyId ?? existingCustomerRel?.party?.id ?? undefined,
        status: project.status,
        budget: project.budget ?? undefined,
        startDate: toDateInput(project.startDate),
        // For pre-existing projects with no end date, fall back to the
        // far-future sentinel so the field is never empty.
        endDate: toDateInput(project.endDate) || DEFAULT_OPEN_END_DATE,
        authoringToolVersion: (project as any).authoringToolVersion ?? '',
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

      const oldCustomerOrgId = existingCustomerRel?.partyId
        ?? existingCustomerRel?.party?.id
        ?? null;
      const customerChanged =
        canChangeCustomer && newCustomerOrgId && newCustomerOrgId !== oldCustomerOrgId;

      // BM2 ops-surfaces Phase A: project participation lives on
      // /project-partner-roles, keyed by ProjectRoleType.code='customer'.
      const swapCustomerIfNeeded = async () => {
        if (!customerChanged) return;
        // 1. End the current customer project-partner-role (soft-end, preserves history).
        if (existingCustomerRel?.id) {
          await client.delete(`/project-partner-roles/${existingCustomerRel.id}`)
            .catch(() => undefined);
        }
        // 2. Look up the project-role-type id ('customer') and create the new row.
        const roleTypes = await client.get('/admin/project-role-types')
          .then((r) => r.data?.data ?? r.data ?? []);
        const customerRole = (Array.isArray(roleTypes) ? roleTypes : []).find(
          (rt: any) => rt.code === 'customer',
        );
        if (!customerRole) {
          throw new Error('project role type "customer" missing');
        }
        await client.post('/project-partner-roles', {
          projectId,
          partyId: newCustomerOrgId,
          roleId: customerRole.id,
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
      // BM2 QA-2 Commit 5 (PR-023): Team roles are all OPTIONAL at project
      // creation. No client-side blocker on missing roles; the backend's
      // matching required-role check was also removed. Build the payload
      // from the assignments the user queued in TeamPicker. Zero rows is
      // fine — the roleAssignments field is simply omitted. Each row is
      // marked isPrimary=true so it satisfies the per-role primary-slot
      // uniqueness constraint (project_partner_roles.@@unique on
      // [projectId, partyId, roleId, validFrom]).
      const roleAssignments = teamAssignments.map((a) => ({
        roleId: a.roleId,
        partyId: a.partyId,
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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-800/50">
      <div className="max-w-[640px] mx-auto py-8 px-4">
        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 mb-5"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Page title */}
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mb-6">
          {isEdit ? 'Edit Project' : 'New Project'}
        </h1>

        <form
          onSubmit={handleSubmit(onSubmit, (errs) => {
            // Auto-scroll to the error banner on any submit failure.
            // Users were clicking Save at the bottom of the form, getting
            // no visible feedback (errors render at the TOP), and
            // reporting "can't create project" — when in fact the form
            // had errors they never saw. Bringing the banner into view
            // makes the failure explicit. Falls back to scrolling the
            // first invalid field if the banner ref isn't found.
            setTimeout(() => {
              const banner = document.getElementById('project-form-errors');
              if (banner) {
                banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
              }
              const firstKey = Object.keys(errs)[0];
              if (firstKey) {
                document.querySelector<HTMLElement>(`[name="${firstKey}"]`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }, 50);
          })}
        >
          {/* Validation error banner — pairs each issue with the
              field label and a click handler that focuses the input.
              Replaces the old raw-zod-message list which was a debugging
              view ("Expected number, received nan") rather than a user
              guide. */}
          {Object.keys(errors).length > 0 && (
            <div id="project-form-errors" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-700 mb-1">Please fix the following before saving:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {Object.entries(errors).map(([field, error]) => {
                  const label = FIELD_LABELS[field] ?? field;
                  // zod's default "Expected number, received nan" is
                  // technical jargon — rewrite to a human prompt.
                  let msg = (error as any)?.message ?? '';
                  if (!msg || /expected.*received/i.test(msg)) {
                    msg = `Please fill in this field.`;
                  }
                  return (
                    <li key={field} className="text-sm text-red-600">
                      <button
                        type="button"
                        onClick={() => {
                          // Focus the matching named input (works for
                          // <input>, <select>, <textarea> registered
                          // via react-hook-form). Scrolls into view
                          // for free thanks to focus({preventScroll:false}).
                          const el = document.querySelector<HTMLElement>(`[name="${field}"]`);
                          el?.focus();
                          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }}
                        className="text-left hover:underline focus:underline focus:outline-none"
                      >
                        <span className="font-semibold">{label}:</span> {msg}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="bg-white dark:bg-slate-900 rounded-[14px] border border-slate-200 dark:border-slate-700">
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

                {/* Project Number — behavior depends on the PROJECT number
                    range. auto = system-assigned (read-only); manual/external
                    = user-typed + server-validated; none = free text. */}
                <div>
                  <label className={labelClass}>Project Number</label>
                  {numberMode === 'auto' ? (
                    <>
                      {/* Not registered → no value submitted; the server
                          allocates the next code on save. */}
                      <input
                        type="text"
                        readOnly
                        value={isEdit ? (watch('number') || '—') : (numberConfig?.preview ?? 'Auto-generated')}
                        className={`${inputClass} bg-slate-50 dark:bg-slate-800/50 cursor-not-allowed text-slate-500 dark:text-slate-400`}
                        title="Assigned automatically by the system"
                      />
                      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                        {isEdit
                          ? 'System-managed — the project number can’t be changed.'
                          : (
                            <>
                              Assigned automatically on save
                              {numberConfig?.preview ? <> (next: <span className="font-mono">{numberConfig.preview}</span>)</> : ''}.
                            </>
                          )}
                      </p>
                    </>
                  ) : (
                    <>
                      <input
                        {...register('number')}
                        placeholder={numberConfig?.externalPattern ? `Pattern: ${numberConfig.externalPattern}` : 'e.g. PRJ-001'}
                        className={inputClass}
                      />
                      {numberMode && (
                        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                          Required — must match the configured project number range
                          {numberConfig?.externalPattern ? ' pattern.' : '.'}
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Project Category (was "Project Type" — renamed per V4
                    since the two were the same concept causing confusion). */}
                <div>
                  <label className={labelClass}>
                    Project Category <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    {(() => {
                      const selectedId = watch('projectTypeId');
                      const selectedType = (projectTypes ?? []).find((t: any) => String(t.id) === String(selectedId));
                      const color = selectedType?.color;
                      return color ? (
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-slate-200 dark:border-slate-700 z-10"
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

                {/* Department field removed (V3) — unused per spec.
                    Field still exists in the DTO/DB so legacy data is
                    preserved; it just stops being editable from the
                    create form. Future cleanup migration can drop the
                    column. */}

                {/* Customer (required at create; locked in edit mode) */}
                <div>
                  <label className={labelClass}>
                    Customer <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register('customerOrgId')}
                    disabled={!canChangeCustomer || (!isEdit && customers.length === 0)}
                    className={`${errors.customerOrgId ? inputErrorClass : inputClass} ${!canChangeCustomer ? 'bg-slate-50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`}
                  >
                    <option value="">
                      {customers.length === 0 && !isEdit
                        ? 'No customer organizations — create one first ↓'
                        : 'Select customer organization'}
                    </option>
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
                  <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                    {!isEdit ? (
                      customers.length === 0 ? (
                        // Empty-state explainer — the dropdown was silently empty
                        // when no organizations were tagged with the 'customer'
                        // role-type, leaving the user stuck on "can't create
                        // project". Now we name the cause and give a one-click
                        // path to fix it.
                        <span className="text-amber-600">
                          No organizations are tagged as <strong>customer</strong> yet.{' '}
                          <a href="/partners?tab=organizations" className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">
                            Add one in Partners → Organizations
                          </a>{' '}
                          and tag it with the customer role-type.
                        </span>
                      ) : (
                        <>Need a new customer? Add it from <a href="/partners?tab=organizations" className="text-blue-600 hover:underline" target="_blank" rel="noreferrer">Partners → Organizations</a> first.</>
                      )
                    ) : isAdmin ? (
                      'Saving will end the previous customer-of-project relationship and start a new one (history is preserved).'
                    ) : (
                      'Customer is locked after project creation — only an admin can reassign it.'
                    )}
                  </p>
                </div>

                {/* Team-role pickers used to live here. They moved to the
                    TEAM section so all people-on-the-project fields
                    (Project Leader + BIM Leader / Architect / Engineer /
                    etc.) sit in one place — per user request. BM2 QA-2
                    Commit 5 (PR-023) made every picker optional. */}

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
            <div className="border-t border-slate-200 dark:border-slate-700" />

            {/* Section 2: Budget & Schedule */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>
                {showFinance ? 'BUDGET & SCHEDULE' : 'SCHEDULE'}
              </h2>

              <div className={`mt-4 grid gap-4 ${showFinance ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {/* Budget — finance-gated. Same gate that hides the Cost tab
                    and Budget column on the project list. */}
                {showFinance && (
                  <div>
                    <label className={labelClass}>Budget</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500 dark:text-slate-400">
                        &#8362;
                      </span>
                      <input
                        {...register('budget')}
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        className="w-full pl-7 pr-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                {/* Start Date */}
                <div>
                  <label className={labelClass}>Start Date</label>
                  <input {...register('startDate')} type="date" className={inputClass} />
                </div>

                {/* End Date */}
                <div>
                  <label className={labelClass}>End Date</label>
                  <input {...register('endDate')} type="date" className={inputClass} />
                  <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                    Defaults to <code>9999-12-31</code> (open-ended) — set a real date when the project has a known finish.
                  </p>
                </div>

                {/* Authoring Tool Version — free text (Y2). Also editable
                    from the Project Info tab; surfaced here so it can be
                    captured at create time. */}
                <div>
                  <label className={labelClass}>Authoring Tool Version</label>
                  <input
                    {...register('authoringToolVersion')}
                    type="text"
                    placeholder='e.g. "Revit 2024.2"'
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200 dark:border-slate-700" />

            {/* Section 3: Team */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>TEAM</h2>

              <div className="mt-4 flex flex-col gap-3">
                {/* QA3 Commit B — replaced the long stack of one <select>
                    per role-type with a single "+ Add role" picker.
                    Nothing is forced (PR-023 lives on): zero assignments
                    submits fine, and the Team tab still exists for adding
                    more after the project is created. "Project Leader"
                    lives here too as one of the roles (system-seeded
                    `team_leader`) — no separate dropdown. */}
                {!isEdit && (
                  <TeamPicker
                    roles={teamRoles}
                    assignments={teamAssignments}
                    onChange={setTeamAssignments}
                  />
                )}

                {/* Other team members are managed from the Team tab on
                    the project detail page — keeping the create flow
                    focused on the required people. */}
                <p className="text-[11px] text-slate-400 dark:text-slate-500 italic">
                  Additional team members are managed from the project's <strong>Team</strong> tab after the project is created.
                </p>
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200 dark:border-slate-700" />

            {/* Section 4: Description */}
            <div className="p-6">
              <h2 className={sectionHeadingClass}>DESCRIPTION</h2>

              <div className="mt-4">
                <textarea
                  {...register('description')}
                  rows={3}
                  placeholder="Add a project description..."
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none resize-none"
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
            <div className="border-t border-slate-200 dark:border-slate-700" />

            {/* Footer buttons */}
            <div className="p-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-2"
               aria-label="Loading">
                {isPending && <Loader2 className="h-4 w-4 animate-spin"  aria-hidden="true" />}
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
      <p className="text-[12px] text-slate-500 dark:text-slate-400 mb-2">
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
        <span className="text-slate-500 dark:text-slate-400">
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
            className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
            title="Hide custom name; default to the provider"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Team Picker ────────────────────────────────────────────────────────
   QA3 Commit B — replaces the previous "one <select> per ProjectRoleType"
   stack on the New-Project form. UX:

     ┌ TEAM ────────────────────────────────────────────────┐
     │  [BIM Manager] · Jane Doe          [×]               │
     │  [Architect]   · John Smith        [×]               │
     │                                                      │
     │  [+ Add role]                                        │
     │                                                      │
     │  (when adding) ┌─────────────────────────────────┐   │
     │                │ Role   [Select role       ▾]    │   │
     │                │ Person [Search / pick person…]  │   │
     │                │ [Add] [Cancel]                  │   │
     │                └─────────────────────────────────┘   │
     └──────────────────────────────────────────────────────┘

   Everything is optional (PR-023). Zero assignments submits fine.
   Dedupes (roleId, partyId) so the same person can't be added to the
   same role twice — the ProjectPartnerRole @@unique on
   [projectId, partyId, roleId, validFrom] would reject it anyway, but
   catching it here avoids a late server error.

   Candidates are fetched per role using the same /business-partners
   query the old TeamRolePicker used (partnerType filtered by
   allowedPartnerKind, plus optional roleType filter). Persons and
   organizations both flow through PeopleMultiSelect — its Person
   shape is opaque numeric id + displayName + optional avatar, and
   works fine for orgs (initials-fallback avatar). */

type TeamRole = {
  id: number;
  name: string;
  code: string;
  allowedPartnerKind: 'person' | 'organization' | 'any';
  requiredPartnerRoleCode: string | null;
  description: string | null;
};

function TeamPicker({
  roles,
  assignments,
  onChange,
}: {
  roles: TeamRole[];
  assignments: Array<{ tempId: string; roleId: number; partyId: number }>;
  onChange: (
    next: Array<{ tempId: string; roleId: number; partyId: number }>,
  ) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draftRoleId, setDraftRoleId] = useState<number | null>(null);
  // PeopleMultiSelect returns a number[]; we constrain to 0-or-1 by
  // taking the last-picked id and discarding earlier ones. Keeps the
  // multi-select UX (search box, avatar rows, chip) while enforcing
  // single-select semantics for the "one person per assignment" model.
  const [draftPartyIds, setDraftPartyIds] = useState<number[]>([]);

  const roleById = useMemo(() => {
    const m = new Map<number, TeamRole>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  const draftRole = draftRoleId != null ? roleById.get(draftRoleId) ?? null : null;

  const remove = (tempId: string) =>
    onChange(assignments.filter((a) => a.tempId !== tempId));

  const startAdding = () => {
    setDraftRoleId(null);
    setDraftPartyIds([]);
    setAdding(true);
  };
  const cancelAdding = () => {
    setDraftRoleId(null);
    setDraftPartyIds([]);
    setAdding(false);
  };

  const commit = () => {
    if (draftRoleId == null || draftPartyIds.length === 0) return;
    const partyId = draftPartyIds[draftPartyIds.length - 1]!;
    const dupe = assignments.some(
      (a) => a.roleId === draftRoleId && a.partyId === partyId,
    );
    if (dupe) {
      // Silently no-op with a toast rather than throwing — user just
      // picked the same combo they already had. `notify` is used across
      // the form for user-facing feedback.
      notify.info('That person is already assigned to that role.', {
        code: 'PROJECT-ROLE-DUP',
      });
      return;
    }
    onChange([
      ...assignments,
      {
        // Fresh tempId per row so React keys stay stable across adds
        // and removes. crypto.randomUUID is present in every browser we
        // target (matches other Planwise call sites); no fallback needed.
        tempId:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        roleId: draftRoleId,
        partyId,
      },
    ]);
    cancelAdding();
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Chosen assignments — chip on the left (role), person name +
          × on the right. Mirrors the QA2-4 RoleMultiSelect chip look
          (rounded-full, blue-tinted) so both surfaces read as siblings. */}
      {assignments.length === 0 && !adding && (
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          No team roles assigned yet — add one below, or leave blank and
          assign roles later from the project's Team tab.
        </p>
      )}
      {assignments.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {assignments.map((a) => {
            const role = roleById.get(a.roleId);
            return (
              <li
                key={a.tempId}
                className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5"
              >
                <span className="inline-flex items-center rounded-full border border-blue-500 bg-blue-50 dark:bg-blue-900/30 px-2 py-[2px] text-[11px] font-semibold text-blue-700 dark:text-blue-300">
                  {role?.name ?? `Role #${a.roleId}`}
                </span>
                {/* Party name — resolved by the inline PartyName lookup so
                    we don't have to plumb the full candidate list up here. */}
                <PartyName role={role} partyId={a.partyId} />
                <button
                  type="button"
                  onClick={() => remove(a.tempId)}
                  aria-label="Remove assignment"
                  className="ml-auto rounded p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-100"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add-role affordance. When idle, a compact link-styled button.
          When adding, an inline panel with role + person selects. */}
      {!adding && (
        <button
          type="button"
          onClick={startAdding}
          disabled={roles.length === 0}
          className="mt-1 self-start inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add role
        </button>
      )}
      {!adding && roles.length === 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          No project role types configured yet. Add them under
          {' '}<a href="/admin/project-role-types" className="underline">Admin → Project Role Types</a>.
        </p>
      )}

      {adding && (
        <div className="mt-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-3 flex flex-col gap-2.5">
          <div>
            <label className={labelClass}>Role</label>
            <select
              value={draftRoleId ?? ''}
              onChange={(e) => {
                const next = e.target.value ? Number(e.target.value) : null;
                setDraftRoleId(next);
                // Reset the person selection when the role changes — the
                // eligible-party pool differs across roles.
                setDraftPartyIds([]);
              }}
              className={inputClass}
              autoFocus
            >
              <option value="">Select a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Person</label>
            {draftRole ? (
              <TeamPartyPicker
                role={draftRole}
                value={draftPartyIds}
                onChange={(ids) => {
                  // Single-select semantics: keep only the last picked id.
                  // Passing `[]` (all cleared) also lands here.
                  setDraftPartyIds(ids.length === 0 ? [] : [ids[ids.length - 1]!]);
                }}
              />
            ) : (
              <p className="text-[12px] text-slate-400 dark:text-slate-500 italic px-1">
                Pick a role first.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={cancelAdding}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[12px] font-semibold px-3 py-1.5 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={draftRoleId == null || draftPartyIds.length === 0}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Small helper — fetches the candidates for a role and renders
   PeopleMultiSelect. Wrapped so the candidate query lives inside the
   picker (not in TeamPicker's own state) and rebuilds when the role
   changes. */
function TeamPartyPicker({
  role,
  value,
  onChange,
}: {
  role: TeamRole;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: candidates = [] } = useQuery<any[]>({
    // Same query key/shape the old TeamRolePicker used, so any cached
    // response is reused here. staleTime matches the previous minute.
    queryKey: ['team-role-candidates', role.id],
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

  const people: Person[] = useMemo(
    () =>
      candidates.map((c: any) => ({
        userId: c.id,
        displayName: c.displayName,
        avatarUrl: c.avatarUrl ?? null,
        // Small subtitle so the row disambiguates person-vs-org and
        // exposes the party's own role/type. Falls back to empty.
        subtitle:
          c.partnerType === 'organization'
            ? 'Organization'
            : c.email ?? null,
      })),
    [candidates],
  );

  if (candidates.length === 0) {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-400 px-1">
        No eligible {role.allowedPartnerKind === 'any' ? 'parties' : `${role.allowedPartnerKind}s`}
        {role.requiredPartnerRoleCode ? ` with role "${role.requiredPartnerRoleCode}"` : ''}
        . Ask an admin to add one under Admin → Employees first, or skip
        this role and assign later from the project's Team tab.
      </p>
    );
  }

  return (
    <PeopleMultiSelect
      people={people}
      value={value}
      onChange={onChange}
      placeholder={`Select ${role.allowedPartnerKind === 'organization' ? 'organization' : 'person'}…`}
      triggerClassName="w-full"
      title={`${role.name} — pick a ${role.allowedPartnerKind === 'organization' ? 'organization' : 'person'}`}
    />
  );
}

/* Read-only party-name lookup used in the chip-row list. Uses the same
   /business-partners response the picker already cached, so it's a
   zero-cost read for anything the user just clicked on. Falls back to
   the id when the row isn't in the cached candidate set (rare). */
function PartyName({
  role,
  partyId,
}: {
  role: TeamRole | undefined;
  partyId: number;
}) {
  const { data: candidates = [] } = useQuery<any[]>({
    queryKey: ['team-role-candidates', role?.id ?? 0],
    enabled: !!role,
    staleTime: 60 * 1000,
    queryFn: () =>
      client.get('/business-partners', {
        params: {
          partnerType: role && role.allowedPartnerKind !== 'any' ? role.allowedPartnerKind : undefined,
          roleType: role?.requiredPartnerRoleCode ?? undefined,
          perPage: 500,
        },
      }).then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : (d?.data ?? []);
      }),
  });
  const bp = candidates.find((c: any) => c.id === partyId);
  return (
    <span className="text-[12.5px] text-slate-700 dark:text-slate-200 truncate">
      {bp?.displayName ?? `#${partyId}`}
    </span>
  );
}
