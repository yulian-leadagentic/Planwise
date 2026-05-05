import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Loader2, X, Search, UserCircle, Users } from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';
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

interface User {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

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
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();

  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'active'],
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
        const d = r.data.data ?? r.data;
        const list = d.data ?? d;
        return Array.isArray(list) ? list.filter((u: any) => u.isActive !== false) : [];
      }),
  });

  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberDropdownOpen, setMemberDropdownOpen] = useState(false);
  const [showTeamTemplatePicker, setShowTeamTemplatePicker] = useState(false);
  // Optional quick link — Google Drive / network share / etc. Saved as a
  // ProjectFile of kind=link after the project is created/updated, so it's
  // visible in the existing Files tab.
  const [quickLinkUrl, setQuickLinkUrl] = useState('');
  const [quickLinkName, setQuickLinkName] = useState('');

  // Fetch team templates for the picker
  const { data: teamTemplates = [] } = useQuery<any[]>({
    queryKey: ['team-templates'],
    queryFn: () =>
      client.get('/admin/config/team-templates').then((r) => {
        const d = r.data.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

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
      if ((project as any).members) {
        const ids = ((project as any).members as any[])
          .filter((m: any) => m.role !== 'Project Leader')
          .map((m: any) => m.userId ?? m.id);
        setMemberIds(ids);
      }
    }
  }, [project, isEdit, reset, existingCustomerRel]);

  const filteredMemberUsers = useMemo(() => {
    if (!users) return [];
    return users.filter((u) => {
      if (memberIds.includes(u.id)) return false;
      if (!memberSearch) return true;
      const full = `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase();
      return full.includes(memberSearch.toLowerCase());
    });
  }, [users, memberIds, memberSearch]);

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
    const payload: any = { ...data, memberIds };

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
      createProject.mutate(payload, {
        onSuccess: async (created: any) => {
          await persistQuickLinkIfNeeded(created.id);
          navigate(`/projects/${created.id}`);
        },
      });
    }
  };

  const isPending = createProject.isPending || updateProject.isPending;

  const addMember = (userId: number) => {
    setMemberIds((prev) => [...prev, userId]);
    setMemberSearch('');
    setMemberDropdownOpen(false);
  };

  const removeMember = (userId: number) => {
    setMemberIds((prev) => prev.filter((id) => id !== userId));
  };

  const applyTeamTemplate = (templateId: number) => {
    const template = teamTemplates.find((t) => t.id === templateId);
    if (!template) return;
    const templateMemberIds: number[] = (template.members || [])
      .map((m: any) => m.userId ?? m.user?.id)
      .filter((id: any): id is number => typeof id === 'number');
    setMemberIds((prev) => {
      const next = new Set(prev);
      templateMemberIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
    setShowTeamTemplatePicker(false);
    notify.success(
      `Loaded ${templateMemberIds.length} member${templateMemberIds.length !== 1 ? 's' : ''} from "${template.name}"`,
      { code: 'TEAM-LOAD-200' },
    );
  };

  const getUserName = (userId: number) => {
    const u = users?.find((u) => u.id === userId);
    return u ? `${u.firstName} ${u.lastName}` : `User ${userId}`;
  };

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
                {/* Project Leader */}
                <div>
                  <label className={labelClass}>Project Leader</label>
                  <select {...register('leaderId')} className={inputClass}>
                    <option value="">Select leader</option>
                    {(users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.firstName} {u.lastName} - {u.email}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Team Members */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className={labelClass + ' mb-0'}>Team Members</label>
                    <button
                      type="button"
                      onClick={() => setShowTeamTemplatePicker(true)}
                      className="flex items-center gap-1.5 text-[12px] font-semibold text-blue-600 hover:text-blue-700"
                    >
                      <Users className="h-3.5 w-3.5" />
                      Add from Team Template
                    </button>
                  </div>

                  {/* Selected member pills */}
                  {memberIds.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {memberIds.map((mid) => (
                        <span
                          key={mid}
                          className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-700 text-[13px] font-semibold px-2.5 py-1 rounded-lg"
                        >
                          <UserCircle className="h-4 w-4 text-slate-400" />
                          {getUserName(mid)}
                          <button
                            type="button"
                            onClick={() => removeMember(mid)}
                            className="ml-0.5 text-slate-400 hover:text-slate-600"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Member search input */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Add team members..."
                      value={memberSearch}
                      onChange={(e) => {
                        setMemberSearch(e.target.value);
                        setMemberDropdownOpen(true);
                      }}
                      onFocus={() => setMemberDropdownOpen(true)}
                      onBlur={() => {
                        // Delay to allow click on option
                        setTimeout(() => setMemberDropdownOpen(false), 200);
                      }}
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                    />

                    {/* Dropdown */}
                    {memberDropdownOpen && filteredMemberUsers.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white rounded-lg border border-slate-200 shadow-sm">
                        {filteredMemberUsers.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => addMember(u.id)}
                            className="w-full px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                          >
                            <UserCircle className="h-4 w-4 text-slate-400 shrink-0" />
                            <span>
                              {u.firstName} {u.lastName}
                              <span className="text-slate-500 ml-1">- {u.email}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
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

              {/* Optional quick link — Google Drive folder / network share / etc.
                  Saved as a ProjectFile of kind=link, visible in the Files tab. */}
              <div className="mt-5">
                <label className={labelClass}>Quick link (optional)</label>
                <p className="text-[12px] text-slate-500 mb-2">
                  Attach a Google Drive folder, network share, or external URL so the team has it on day one.
                  More links can be added from the Files tab later.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={quickLinkName}
                    onChange={(e) => setQuickLinkName(e.target.value)}
                    placeholder="Display name (e.g. Drive folder)"
                    className={`${inputClass} sm:max-w-xs`}
                  />
                  <input
                    type="text"
                    value={quickLinkUrl}
                    onChange={(e) => setQuickLinkUrl(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/...   or   \\server\share\..."
                    className={`${inputClass} font-mono text-[12px] flex-1`}
                  />
                  {/* Native file picker — same caveat as the Add File Link form:
                      browsers strip the full path for security, so we only get
                      the file name. Useful as a "fill in the file name and add
                      your share prefix manually" shortcut. */}
                  <label className="rounded-lg border border-slate-200 bg-white hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-2 cursor-pointer flex items-center justify-center gap-1.5 shrink-0">
                    Browse…
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setQuickLinkUrl(file.name);
                        if (!quickLinkName.trim()) {
                          setQuickLinkName(file.name.replace(/\.[^.]+$/, ''));
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Browsers can't read the full file path for security — paste a network share or URL,
                  or use <strong>Browse…</strong> to grab the file name and prepend the prefix manually.
                </p>
                {quickLinkUrl.trim() && (() => {
                  const label = detectProviderLabel(quickLinkUrl.trim());
                  if (label === 'External link') return null;
                  return (
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Detected as <span className="font-semibold">{label}</span>
                    </p>
                  );
                })()}
              </div>
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

        {/* Team Template Picker Modal */}
        {showTeamTemplatePicker && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setShowTeamTemplatePicker(false)}
          >
            <div
              className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[14px] border border-slate-200 bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-blue-600" />
                  <h2 className="text-base font-semibold">Add from Team Template</h2>
                </div>
                <button
                  onClick={() => setShowTeamTemplatePicker(false)}
                  className="rounded-md p-1.5 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {teamTemplates.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">
                    No team templates available. Create one in Templates → Team Templates.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {teamTemplates.map((t) => {
                      const memberCount = t._count?.members ?? t.members?.length ?? 0;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => applyTeamTemplate(t.id)}
                          className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-blue-400 hover:bg-blue-50/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-slate-900">{t.name}</p>
                              <p className="mt-0.5 text-xs text-slate-500">
                                {memberCount} member{memberCount !== 1 ? 's' : ''}
                              </p>
                              {t.members && t.members.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {t.members.slice(0, 6).map((m: any) => {
                                    const u = m.user ?? {};
                                    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Unknown';
                                    return (
                                      <span
                                        key={m.id}
                                        className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                                      >
                                        <UserCircle className="h-3 w-3 text-slate-400" />
                                        {name}
                                      </span>
                                    );
                                  })}
                                  {t.members.length > 6 && (
                                    <span className="text-[11px] text-slate-400">+{t.members.length - 6} more</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={() => setShowTeamTemplatePicker(false)}
                  className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
