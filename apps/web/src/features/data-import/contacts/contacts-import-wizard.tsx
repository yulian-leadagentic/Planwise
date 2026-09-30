/**
 * BM2 · Contacts import wizard — sub-mode of /admin/data-import.
 *
 * Six stages per `docs/bm2/bp-import-methodology.md` §3:
 *   1. Triage — magic-byte sniff + tolerant reader (server-side).
 *   2. Header detection — per-sheet score against §4 dictionary.
 *   3. Column mapping — dictionary auto-suggest + preset dropdown +
 *                        Save as preset.
 *   4. Split & fill — server-side; every split/inherited cell marked.
 *   5. Preview + conflict resolution — visible markers for synthesized
 *                                       cells; per-row link/create/skip
 *                                       decisions.
 *   6. Commit — idempotent (Stage 6 commit; wired in the Stage 6 commit).
 *
 * The wizard state (uploaded sheets, mapping, decisions) lives in this
 * component — the server is stateless across stages. This matches the
 * shape of the retired BM2 Phase E BP-admin importer so a returning
 * user sees the same interaction model.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Upload,
  AlertTriangle,
  XCircle,
  Info,
  Save as SaveIcon,
  Sparkles,
  FolderKanban,
  Search,
  ChevronDown,
  ChevronRight,
  Building2,
  Trash2,
  RotateCcw,
  X,
  GripVertical,
} from 'lucide-react';
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';

import client from '@/api/client';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useProject, useProjects } from '@/hooks/use-projects';
import { useDebounce } from '@/hooks/use-debounce';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { TextField } from '@/components/shared/field';
import {
  contactsImportApi,
  CONTACT_FIELDS,
  CONTACT_FIELD_LABELS,
  ContactField,
  ContactsMapping,
  DedupDecision,
  ExtractedSheet,
  MappingPreset,
  OverrideField,
  ResolvedRow,
  RowDecision,
  RowOverrides,
  SecondaryContact,
  SheetGrade,
  SheetPreview,
  TriageResult,
  UploadResponse,
} from '@/api/contacts-import.api';

/** Subset of ProjectRoleType we render in the picker. */
interface ProjectRoleTypeLite {
  id: number;
  code: string;
  name: string;
  allowedPartnerKind?: 'person' | 'organization' | 'any';
  sortOrder?: number;
}

/**
 * QA4 R2b ORG-3 — subset of PartnerRoleType used by the Organizations
 * review panel's role selector. Matches the shape returned by
 * `/admin/partner-types/role-types`; we only need name/code/appliesToKind.
 */
interface PartnerRoleTypeLite {
  id: number;
  code: string;
  name: string;
  appliesToKind: 'person' | 'organization' | 'any';
  sortOrder?: number;
  isSystem?: boolean;
}

/**
 * QA4 RD-1 (2026-09-29) — one grouped organization in the unified
 * review. Every DedupDecision folds into exactly ONE bucket:
 *   • an org group — real org identity (batchOrgKey starts with
 *     `bp:` / `domain:` / `name:`), the group's people are shown
 *     nested under the org card
 *   • the individuals bucket — rows the batch key couldn't attach to
 *     a firm (no company, personal/no domain, or a name-only key
 *     that only ever carried one row); rendered in a separate
 *     "Individuals (no organization)" section
 * Supersedes the ORG-2 two-screen split (Organizations panel + flat
 * per-row Preview table).
 */
interface OrgGroup {
  key: string;
  label: string;
  domain: string | null;
  matchedBpId: number | null;
  /** true when the commit path would CREATE this org (matched-existing = false). */
  isNew: boolean;
  people: Array<{ decision: DedupDecision; skipped: boolean }>;
  personCount: number;
  skippedCount: number;
  /** false when the row had no groupable signal. Ungrouped groups
   *  bubble up to the "Individuals" section instead of getting their
   *  own org card. */
  hasBatchKey: boolean;
  /**
   * QA4 RD-1 — true when this group has no real org identity: no
   * matched BP, no domain group, no plausible company name. Renders
   * under "Individuals (no organization)" instead of as an org card.
   */
  isIndividual: boolean;
}

/**
 * QA4 IW-5 (2026-09-30) — imported contacts are always attached to a
 * project with the "External Contact" role. The wizard used to expose
 * a role-type picker with a pre-selected fallback; now the picker is
 * locked read-only and the fallback resolver looks for exactly
 * `external_contact` (falling through to any known alt codes only if
 * that seed is missing on a legacy environment). The backend's own
 * `pickProjectRoleId()` fallback still adds `contact` / `consultant`
 * as a safety net, but the FE never presents them.
 */
const FALLBACK_ROLE_CODES = ['external_contact', 'contact', 'consultant'] as const;

type WizardStep = 'upload' | 'sheet' | 'map' | 'preview' | 'commit';

/**
 * QA4 IW-1 (2026-09-30) — per-batchOrgKey overrides that carry the
 * full BP field set. `name` + `domain` continue to drive org identity
 * (E2); the additional fields land on the freshly-created org BP at
 * commit time. All optional; an unset field falls back to whatever
 * the classifier parsed off the leader row.
 */
type OrgOverrideValues = {
  name?: string;
  domain?: string;
  companyName?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  address?: string;
  notes?: string;
};

/** Every editable BP-level field available on an org card (order = UI order). */
const ORG_EXTRA_FIELDS: Array<{ key: keyof OrgOverrideValues; label: string; type: 'text' | 'url' | 'multiline' }> = [
  { key: 'companyName', label: 'Company name', type: 'text' },
  { key: 'taxId', label: 'Tax ID / code', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'mobile', label: 'Mobile', type: 'text' },
  { key: 'website', label: 'Website', type: 'url' },
  { key: 'address', label: 'Address', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'multiline' },
];

const STEP_LABELS: Record<WizardStep, string> = {
  upload: '1 · Upload',
  sheet: '2 · Pick sheet',
  map: '3 · Map columns',
  preview: '4 · Preview',
  commit: '5 · Commit',
};

export function ContactsImportWizard({
  onDone,
  defaultProjectId = null,
  onDirtyChange,
}: {
  onDone?: () => void;
  /**
   * When the wizard is opened from a project context (e.g. deep-linked
   * via `/admin/data-import?target=contacts&projectId=42`) preselect
   * that project in the attach panel. Users can still clear it for a
   * global import.
   */
  defaultProjectId?: number | null;
  /**
   * Fires whenever the wizard has unsaved conflict decisions the user
   * would lose if the host page cancels the flow. People UX U4
   * (P-20) — the host uses this to gate its top-level Cancel button.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [step, setStep] = useState<WizardStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [grades, setGrades] = useState<SheetGrade[]>([]);
  const [selectedSheetIdx, setSelectedSheetIdx] = useState<number>(0);
  const [mapping, setMapping] = useState<ContactsMapping>({});
  const [headerRowIndex, setHeaderRowIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  // People UX U4 · 2026-09-27 — decisions are keyed by `${sheet}::${rowIndex}`
  // so re-visiting the Preview step after a Map edit can preserve
  // decisions whose source rows still exist (P-20).
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});
  // Snapshot of `mapping` at the moment the first (unrefreshed) decision
  // was made. Used to detect column-mapping edits that would invalidate
  // stored decisions and prompt the reset dialog. People UX U4 · 2026-09-27
  const [decidedMapping, setDecidedMapping] = useState<ContactsMapping | null>(null);
  // Attach-to-project selection lives at the wizard level so it survives
  // step navigation; both fields are optional end-to-end (null = today's
  // "BPs + worker_of only" behaviour).
  const [attachToProjectId, setAttachToProjectId] = useState<number | null>(defaultProjectId);
  const [projectRoleId, setProjectRoleId] = useState<number | null>(null);
  // QA4 R2b ORG-3 (2026-09-29) — user-picked BusinessPartnerRole per
  // distinct batchOrgKey. Committed as `orgTypes` on the commit call;
  // every NEW org must have an entry (matched-existing orgs are
  // exempt — we never downgrade the role they already hold).
  const [orgTypes, setOrgTypes] = useState<Record<string, string>>({});
  // QA4 E2 (2026-09-29) — per-batchOrgKey inline overrides of the
  // org identity (name and/or domain). Applied at commit time via the
  // `orgOverrides` payload; the wizard's grouped review reads them so
  // an edit is visible immediately.
  //
  // QA4 IW-1 (2026-09-30) — extended to carry the full BP field set
  // (taxId, email, phone, mobile, website, address, notes) so the
  // reviewer can complete BP-level fields inline before commit. Only
  // applied to NEW org creates — matched-existing orgs use E5
  // conflict resolution to pick per field.
  const [orgOverrides, setOrgOverrides] = useState<
    Record<string, OrgOverrideValues>
  >({});
  // QA4 E3 (2026-09-29) — orgs the reviewer removed. `orgDeleted` is
  // the set of batchOrgKeys marked deleted; `orgDeleteMode[key]`
  // records whether the reviewer chose to skip the org's people too
  // (`cascade`) or move them to the individuals bucket (`keep-people`).
  // Reversible — clicking Undo drops the key from both.
  const [orgDeleted, setOrgDeleted] = useState<Set<string>>(() => new Set());
  const [orgDeleteMode, setOrgDeleteMode] = useState<
    Record<string, 'cascade' | 'keep-people'>
  >({});
  // QA4 E4 (2026-09-29) — per-row org reassignment. Keyed by
  // sourceRowIndex; value is the target batchOrgKey (or `null` for
  // Individuals). Overrides the row's dedup-time batchOrgKey both in
  // the FE grouping and at commit.
  const [personOrgOverrides, setPersonOrgOverrides] = useState<
    Record<number, string | null>
  >({});
  // QA4 E5 (2026-09-29) — per-field conflict decisions for matched-
  // existing orgs/people. Keyed by a stable id (`org:<batchOrgKey>` or
  // `person:<sourceRowIndex>`); inner map is `field -> 'existing' |
  // 'imported'`. Only differing fields sit here; `existing` is the
  // default so an unresolved diff leaves the DB value untouched.
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, Record<string, 'existing' | 'imported'>>
  >({});
  // QA4 E6 (2026-09-29) — user-created orgs. The reviewer adds a
  // brand-new org (name + optional domain) that appears in the
  // moveTargets list; orphans can then be assigned into it.
  // Backend commit reads its name/domain via `orgOverrides` and its
  // presence via the batch materialisation pass when a personOrg
  // Override points at it.
  const [userCreatedOrgs, setUserCreatedOrgs] = useState<
    Array<{ key: string; name: string; domain?: string }>
  >([]);
  const [commitResult, setCommitResult] = useState<
    | (Awaited<ReturnType<typeof contactsImportApi.commit>>)
    | null
  >(null);

  const sheets: ExtractedSheet[] =
    triage && triage.kind !== 'reject' ? triage.sheets : [];
  const selectedSheet = sheets[selectedSheetIdx] ?? null;
  const selectedGrade = grades[selectedSheetIdx] ?? null;

  // ─── Presets (Stage 3) ────────────────────────────────────────────
  const presetsQuery = useQuery({
    queryKey: ['contacts-import', 'presets'],
    queryFn: () => contactsImportApi.listPresets(),
  });

  // ─── Project role types (for the attach panel) ────────────────────
  // Reused from `role-assignment-picker.tsx` — same endpoint, same
  // wrapped/unwrapped tolerance. Query is safe to fire eagerly; results
  // don't change often and the payload is tiny.
  const roleTypesQuery = useQuery<ProjectRoleTypeLite[]>({
    queryKey: ['project-role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client
        .get('/admin/project-role-types')
        .then((r) => r.data?.data ?? r.data ?? []),
  });

  // When a project is first selected (or role types finally land after
  // prefill), pick the fallback role that mirrors the backend resolver.
  // Runs at most once per (project, role-types) combination — leaves an
  // explicit user choice untouched.
  const roleTypes = roleTypesQuery.data ?? [];
  useEffect(() => {
    if (attachToProjectId == null) return;
    if (projectRoleId != null) return;
    if (roleTypes.length === 0) return;
    const fallback = FALLBACK_ROLE_CODES.map((code) =>
      roleTypes.find((rt) => rt.code === code),
    ).find(Boolean);
    if (fallback) setProjectRoleId(fallback.id);
  }, [attachToProjectId, projectRoleId, roleTypes]);

  // Clear the role selection when the project is cleared — a role
  // without a project makes no sense and would confuse the preview.
  useEffect(() => {
    if (attachToProjectId == null && projectRoleId != null) {
      setProjectRoleId(null);
    }
  }, [attachToProjectId, projectRoleId]);

  // ─── Mutations ────────────────────────────────────────────────────
  const uploadMutation = useMutation({
    mutationFn: (f: File) => contactsImportApi.upload(f),
    onSuccess: (data: UploadResponse) => {
      setTriage(data.triage);
      setGrades(data.grades);
      if (data.triage.kind === 'reject') {
        // Stay on upload with reject message visible
        return;
      }
      // Pre-select the first sheet with an auto verdict, else first sheet.
      const autoIdx = data.grades.findIndex((g) => g.verdict === 'auto');
      const nextIdx = autoIdx >= 0 ? autoIdx : 0;
      setSelectedSheetIdx(nextIdx);
      // Seed mapping from the grade's auto-suggested column indexes.
      const grade = data.grades[nextIdx];
      if (grade) {
        setMapping(indexMappingToHeaderMapping(grade.mapping, grade.headerCells));
        setHeaderRowIndex(grade.headerRowIndex);
      }
      setStep(data.triage.sheets.length > 1 ? 'sheet' : 'map');
    },
    onError: (err) => notify.apiError(err, 'Upload failed'),
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSheet) throw new Error('no sheet selected');
      return contactsImportApi.preview({
        sheet: selectedSheet,
        mapping,
        headerRowIndex: headerRowIndex ?? undefined,
      });
    },
    onSuccess: (data) => {
      setPreview(data);
      // People UX U4 · 2026-09-27 — don't wipe decisions on every preview;
      // `runPreview` below already asked for a reset if the mapping changed.
      setStep('preview');
    },
    onError: (err) => notify.apiError(err, 'Preview failed'),
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSheet) throw new Error('no sheet selected');
      return contactsImportApi.commit({
        sheet: selectedSheet,
        mapping,
        headerRowIndex: headerRowIndex ?? undefined,
        decisions: Object.values(decisions),
        filename: (triage && triage.kind !== 'reject' && triage.filename) || file?.name,
        // Both optional — omit `projectRoleId` when null so the backend
        // runs its fallback resolver rather than treating `null` as an
        // explicit "no role".
        attachToProjectId: attachToProjectId ?? undefined,
        projectRoleId: projectRoleId ?? undefined,
        // QA4 R2b ORG-3 — per-key role picks (only NEW orgs are here;
        // matched-existing orgs never appear because their role stays).
        orgTypes: Object.keys(orgTypes).length > 0 ? orgTypes : undefined,
        // QA4 E2 — inline overrides of org identity (name / domain).
        orgOverrides: Object.keys(orgOverrides).length > 0 ? orgOverrides : undefined,
        // QA4 E3 — reviewer-deleted orgs + their cascade choice.
        orgDeleted: orgDeleted.size > 0 ? [...orgDeleted] : undefined,
        orgDeleteMode: Object.keys(orgDeleteMode).length > 0 ? orgDeleteMode : undefined,
        // QA4 E4 — per-row reassignment (drag/move between org cards).
        personOrgOverrides: Object.keys(personOrgOverrides).length > 0
          ? Object.fromEntries(
              Object.entries(personOrgOverrides).map(([k, v]) => [Number(k), v]),
            )
          : undefined,
        // QA4 E5 — per-field conflict picks (keep existing vs use imported).
        conflictResolutions: Object.keys(conflictResolutions).length > 0 ? conflictResolutions : undefined,
      });
    },
    onSuccess: (data) => {
      setCommitResult(data);
      setStep('commit');
      const ok = data.errors === 0;
      notify[ok ? 'success' : 'warning'](
        ok
          ? `Import complete — created ${data.orgsCreated} orgs · ${data.contactsCreated} contacts`
          : `Import finished with ${data.errors} errors — see the details below`,
        { code: 'CONTACTS-IMPORT' },
      );
      queryClient.invalidateQueries({ queryKey: ['data-import', 'history'] });
    },
    onError: (err) => notify.apiError(err, 'Commit failed'),
  });

  // Whenever the selected sheet changes, re-seed the mapping from its grade.
  // (selectedGrade is derived from selectedSheetIdx, so depending on the
  // index alone is intentional — don't chase selectedGrade into a loop.)
  useEffect(() => {
    if (!selectedGrade) return;
    setMapping(indexMappingToHeaderMapping(selectedGrade.mapping, selectedGrade.headerCells));
    setHeaderRowIndex(selectedGrade.headerRowIndex);
  }, [selectedSheetIdx, selectedGrade]);

  const reset = () => {
    setFile(null);
    setTriage(null);
    setGrades([]);
    setSelectedSheetIdx(0);
    setMapping({});
    setHeaderRowIndex(null);
    setPreview(null);
    setDecisions({});
    setDecidedMapping(null);
    setOrgTypes({});
    setOrgOverrides({});
    setOrgDeleted(new Set());
    setOrgDeleteMode({});
    setPersonOrgOverrides({});
    setConflictResolutions({});
    setUserCreatedOrgs([]);
    setCommitResult(null);
    // Re-apply prefill for "Import another file" — if the wizard was
    // deep-linked from a project, that context still holds. The role
    // effect above re-defaults after the project is re-set.
    setAttachToProjectId(defaultProjectId);
    setProjectRoleId(null);
    setStep('upload');
  };

  // People UX U4 · 2026-09-27
  const decisionsCount = Object.keys(decisions).length;
  const decisionKey = (rowIndex: number) =>
    `${selectedSheet?.name ?? '_'}::${rowIndex}`;

  // Bubble dirty state up so the host page (data-import-page.tsx) can
  // gate its top-level Cancel button. Post-commit we treat the wizard
  // as clean — the decisions were already committed to the server.
  useEffect(() => {
    onDirtyChange?.(decisionsCount > 0 && step !== 'commit');
  }, [decisionsCount, step, onDirtyChange]);

  /**
   * Gate the Map → Preview transition on decision preservation (P-20).
   * If any of the decided columns' mappings changed, ask before wiping
   * the stored decisions. When the mapping is unchanged (or no
   * decisions exist yet) fall through straight to the preview call.
   */
  const runPreview = async () => {
    if (
      decisionsCount > 0 &&
      decidedMapping &&
      !mappingsEqual(mapping, decidedMapping)
    ) {
      const ok = await confirm(
        `Changing the column mapping will reset ${decisionsCount} conflict decision${
          decisionsCount === 1 ? '' : 's'
        } you already made.`,
        {
          title: 'Reset decisions?',
          confirmLabel: 'Reset & preview',
          variant: 'danger',
        },
      );
      if (!ok) return;
      setDecisions({});
      setDecidedMapping(null);
    }
    previewMutation.mutate();
  };

  /**
   * Discard decisions before jumping back to Upload/Sheet — the mapping
   * step keeps them because Preview → Map → Preview is a supported
   * round-trip, but Upload/Sheet reset the sheet identity entirely.
   */
  const confirmDiscardDecisions = async (message: string): Promise<boolean> => {
    if (decisionsCount === 0) return true;
    const ok = await confirm(message, {
      title: 'Discard decisions?',
      confirmLabel: 'Discard',
      variant: 'danger',
    });
    if (ok) {
      setDecisions({});
      setDecidedMapping(null);
    }
    return ok;
  };

  // ─── Top Back handler (QA4 R2b ORG-7) ────────────────────────────
  // Mirrors the footer Back on each step so the reviewer can go back
  // without scrolling. Hidden on step 1 (upload) and step 5 (commit
  // is the terminal step — a fresh reset is offered there instead).
  // Uses the same discard-decisions guard as the footer buttons.
  const topBackHandler = async (): Promise<void> => {
    if (step === 'sheet') {
      // Same behaviour as the SheetPickerStep footer.
      if (
        await confirmDiscardDecisions(
          `Cancelling discards ${decisionsCount} unsaved decision${
            decisionsCount === 1 ? '' : 's'
          } and returns to Upload.`,
        )
      ) {
        reset();
      }
    } else if (step === 'map') {
      if (
        await confirmDiscardDecisions(
          `Going back discards ${decisionsCount} unsaved decision${
            decisionsCount === 1 ? '' : 's'
          }.`,
        )
      ) {
        setStep(sheets.length > 1 ? 'sheet' : 'upload');
      }
    } else if (step === 'preview') {
      setStep('map');
    }
  };
  const topBackEnabled = step !== 'upload' && step !== 'commit';

  // QA4 IW-4 (2026-09-30) — file name in the wizard header. The upload
  // handler stores the File object; triage echoes the server-side
  // filename back on success. Prefer the local File.name (available
  // immediately) and fall back to the triage value for a re-mounted
  // wizard where the File went out of scope.
  const currentFilename =
    file?.name ??
    (triage && triage.kind !== 'reject' ? triage.filename ?? null : null);

  // ─── Stepper ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <Stepper
        step={step}
        onBack={topBackEnabled ? topBackHandler : undefined}
        filename={currentFilename}
      />

      {step === 'upload' && (
        <UploadStep
          file={file}
          onFile={(f) => {
            setFile(f);
            if (f) uploadMutation.mutate(f);
          }}
          isBusy={uploadMutation.isPending}
          triage={triage}
        />
      )}

      {step === 'sheet' && (
        <SheetPickerStep
          triage={triage}
          grades={grades}
          selectedIdx={selectedSheetIdx}
          onSelect={setSelectedSheetIdx}
          onBack={async () => {
            // People UX U4 (P-20): back-to-upload from Sheet is only
            // reachable via Preview → Map → Sheet, so decisions may
            // exist; confirm before wiping them.
            if (
              await confirmDiscardDecisions(
                `Cancelling discards ${decisionsCount} unsaved decision${
                  decisionsCount === 1 ? '' : 's'
                } and returns to Upload.`,
              )
            ) {
              reset();
            }
          }}
          onNext={() => setStep('map')}
        />
      )}

      {step === 'map' && selectedSheet && selectedGrade && (
        <MapStep
          sheet={selectedSheet}
          grade={selectedGrade}
          mapping={mapping}
          onChange={setMapping}
          presets={presetsQuery.data ?? []}
          onApplyPreset={(p) => setMapping({ ...p.mapping })}
          onSavePreset={async (name) => {
            try {
              await contactsImportApi.savePreset({ name, mapping });
              notify.success(`Preset "${name}" saved`, { code: 'PRESET-SAVE' });
              queryClient.invalidateQueries({ queryKey: ['contacts-import', 'presets'] });
            } catch (err) {
              notify.apiError(err, 'Could not save preset');
            }
          }}
          onBack={async () => {
            // People UX U4 (P-20): going back past Map loses the row
            // decisions unless the user has none.
            if (
              await confirmDiscardDecisions(
                `Going back discards ${decisionsCount} unsaved decision${
                  decisionsCount === 1 ? '' : 's'
                }.`,
              )
            ) {
              setStep(sheets.length > 1 ? 'sheet' : 'upload');
            }
          }}
          onNext={runPreview}
          isBusy={previewMutation.isPending}
        />
      )}

      {step === 'preview' && preview && selectedSheet && (
        <PreviewStep
          preview={preview}
          sheetName={selectedSheet.name}
          decisions={decisions}
          orgTypes={orgTypes}
          orgOverrides={orgOverrides}
          orgDeleted={orgDeleted}
          orgDeleteMode={orgDeleteMode}
          personOrgOverrides={personOrgOverrides}
          conflictResolutions={conflictResolutions}
          onOrgTypeChange={(key, code) =>
            setOrgTypes((prev) => {
              const next = { ...prev };
              if (!code) delete next[key];
              else next[key] = code;
              return next;
            })
          }
          onOrgOverride={(key, patch) =>
            setOrgOverrides((prev) => {
              const merged: OrgOverrideValues = { ...(prev[key] ?? {}), ...patch };
              // QA4 IW-1 (2026-09-30) — strip empty strings + undefined
              // per field so a cleared value falls back to the parsed
              // value (or nothing) at commit. `domain` is lower-cased.
              const cleaned: OrgOverrideValues = {};
              if (merged.name && merged.name.trim()) cleaned.name = merged.name.trim();
              if (merged.domain && merged.domain.trim()) cleaned.domain = merged.domain.trim().toLowerCase();
              if (merged.companyName && merged.companyName.trim()) cleaned.companyName = merged.companyName.trim();
              if (merged.taxId && merged.taxId.trim()) cleaned.taxId = merged.taxId.trim();
              if (merged.email && merged.email.trim()) cleaned.email = merged.email.trim();
              if (merged.phone && merged.phone.trim()) cleaned.phone = merged.phone.trim();
              if (merged.mobile && merged.mobile.trim()) cleaned.mobile = merged.mobile.trim();
              if (merged.website && merged.website.trim()) cleaned.website = merged.website.trim();
              if (merged.address && merged.address.trim()) cleaned.address = merged.address.trim();
              if (merged.notes && merged.notes.trim()) cleaned.notes = merged.notes.trim();
              const next = { ...prev };
              if (Object.keys(cleaned).length === 0) delete next[key];
              else next[key] = cleaned;
              return next;
            })
          }
          onOrgDelete={(key, mode) => {
            setOrgDeleted((prev) => {
              const next = new Set(prev);
              next.add(key);
              return next;
            });
            setOrgDeleteMode((prev) => ({ ...prev, [key]: mode }));
          }}
          onOrgDeleteUndo={(key) => {
            setOrgDeleted((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
            setOrgDeleteMode((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }}
          onMovePerson={(rowIndex, targetKey) =>
            setPersonOrgOverrides((prev) => {
              const next = { ...prev };
              next[rowIndex] = targetKey;
              return next;
            })
          }
          onConflictResolve={(recordKey, field, choice) =>
            setConflictResolutions((prev) => {
              const inner = { ...(prev[recordKey] ?? {}) };
              inner[field] = choice;
              return { ...prev, [recordKey]: inner };
            })
          }
          userCreatedOrgs={userCreatedOrgs}
          onCreateOrg={(name, domain) => {
            const key = `user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            setUserCreatedOrgs((prev) => [...prev, { key, name, domain }]);
            // Seed the orgOverrides so commit's org create writes the
            // reviewer's typed name + domain (the batch pass reads
            // orgOverrides[key] for any create branch).
            setOrgOverrides((prev) => ({
              ...prev,
              [key]: { name, ...(domain ? { domain: domain.toLowerCase() } : {}) },
            }));
            return key;
          }}
          onDecide={(rowIndex, patch) => {
            const key = decisionKey(rowIndex);
            setDecisions((prev) => ({
              ...prev,
              [key]: { ...prev[key], ...patch, sourceRowIndex: rowIndex },
            }));
            // Snapshot the mapping on first decision (or after a reset)
            // so mapping edits can be detected on the next Preview.
            // People UX U4 · 2026-09-27
            if (decidedMapping == null) setDecidedMapping({ ...mapping });
          }}
          onOverride={(rowIndex, field, value) => {
            // QA4 IMP-2 — inline per-field overrides. Merge into the
            // row's decision's `overrides` map without clobbering
            // sibling fields; `null` clears the parsed value; a fresh
            // `undefined` value removes the override entirely so the
            // cell falls back to the classifier output.
            const key = decisionKey(rowIndex);
            setDecisions((prev) => {
              const existing = prev[key];
              const prevOverrides = existing?.overrides ?? {};
              const nextOverrides: RowOverrides = { ...prevOverrides };
              if (value === undefined) {
                delete nextOverrides[field];
              } else {
                nextOverrides[field] = value;
              }
              return {
                ...prev,
                [key]: {
                  ...existing,
                  sourceRowIndex: rowIndex,
                  overrides:
                    Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
                },
              };
            });
            if (decidedMapping == null) setDecidedMapping({ ...mapping });
          }}
          attachToProjectId={attachToProjectId}
          onAttachProjectChange={setAttachToProjectId}
          projectRoleId={projectRoleId}
          onProjectRoleChange={setProjectRoleId}
          roleTypes={roleTypes}
          roleTypesLoading={roleTypesQuery.isLoading}
          onBack={() => setStep('map')}
          onCommit={() => commitMutation.mutate()}
          isBusy={commitMutation.isPending}
        />
      )}

      {step === 'commit' && commitResult && (
        <CommitStep
          result={commitResult}
          attachToProjectId={attachToProjectId}
          onAnother={reset}
          onDone={onDone}
        />
      )}
    </div>
  );
}

// ─── Stepper ─────────────────────────────────────────────────────────
function Stepper({
  step,
  onBack,
  filename,
}: {
  step: WizardStep;
  /**
   * QA4 R2b ORG-7 (2026-09-29) — optional top Back handler. When
   * supplied a "← Back" control renders next to the progress row so
   * the reviewer can rewind without scrolling to the footer. Hidden
   * on step 1 (nothing to rewind to) and step 5 (commit is terminal).
   */
  onBack?: () => void;
  /**
   * QA4 IW-4 (2026-09-30) — current file name, shown to the right of
   * the step progress on every step. Null before an upload lands.
   * Truncated with ellipsis; full name on the title tooltip.
   */
  filename?: string | null;
}) {
  const steps: WizardStep[] = ['upload', 'sheet', 'map', 'preview', 'commit'];
  const idx = steps.indexOf(step);
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] font-semibold',
            'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300',
            'hover:border-slate-400 dark:hover:border-slate-500 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
          )}
          aria-label="Back to previous step"
          title="Back to previous step"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
        </button>
      )}
      <ol className="flex items-center gap-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex-wrap">
        {steps.map((s, i) => {
          const active = i === idx;
          const done = i < idx;
          return (
            <li key={s} className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold',
                  done && 'bg-emerald-500 text-white',
                  active && 'bg-blue-600 text-white',
                  !done && !active && 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
                )}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={cn(
                  active
                    ? 'text-slate-900 dark:text-slate-100 font-semibold'
                    : 'text-slate-500 dark:text-slate-400',
                )}
              >
                {STEP_LABELS[s]}
              </span>
              {i < steps.length - 1 && (
                <span className="text-slate-300 dark:text-slate-600">›</span>
              )}
            </li>
          );
        })}
      </ol>
      {/* QA4 IW-4 (2026-09-30) — file-name chip on every step. */}
      {filename && (
        <div
          className="ml-auto inline-flex items-center gap-1.5 min-w-0 max-w-[24rem] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-2.5 py-1 text-[11px]"
          title={filename}
        >
          <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 shrink-0">
            File
          </span>
          <span className="truncate text-slate-700 dark:text-slate-200 font-mono" aria-label="Current file name">
            {filename}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Step 1: Upload + Stage 1 triage response ────────────────────────
function UploadStep({
  file,
  onFile,
  isBusy,
  triage,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  isBusy: boolean;
  triage: TriageResult | null;
}) {
  const [drag, setDrag] = useState(false);
  // People UX U4 (P-21) · 2026-09-27 — hidden-inside-label pattern is
  // unreachable by keyboard. `sr-only` on the input + a visible focusable
  // "Choose file" button restores Tab + Enter, and the drop zone keeps
  // its click-to-browse and drag-and-drop for mouse users.
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 space-y-4">
      <div>
        <h2 className="text-[15px] font-bold text-slate-900 dark:text-slate-100">Upload a contacts sheet</h2>
        <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1">
          Any .xlsx, .xls (legacy), .csv, .docx, or .pdf — the wizard sniffs the real file type
          (not the extension) and picks the right reader. No pre-formatting; you'll map columns in
          the next step.
        </p>
      </div>

      <div
        role="group"
        aria-label="File drop zone"
        className={cn(
          'block rounded-lg border-2 border-dashed p-10 text-center transition-colors',
          drag
            ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/30'
            : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 hover:border-slate-300 dark:hover:border-slate-500',
          isBusy && 'cursor-wait',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          accept=".xlsx,.xls,.csv,.docx,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
          aria-label="Contacts sheet file"
        />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <FileSpreadsheet className="h-8 w-8 text-emerald-600" />
            <div className="text-left">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{file.name}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{(file.size / 1024).toFixed(1)} KB</div>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="ml-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none"
            >
              Choose a different file
            </button>
          </div>
        ) : (
          <div>
            <Upload className="mx-auto h-10 w-10 text-slate-400 dark:text-slate-500" />
            <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              Drop your file here, or use the button below
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Max 5 MB · triage never trusts the extension</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isBusy}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50 focus:outline-none focus:border-blue-400"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" /> Choose file
            </button>
          </div>
        )}
      </div>

      {isBusy && (
        <p className="text-[13px] text-slate-500 dark:text-slate-400 flex items-center gap-2">
          <Sparkles className="h-4 w-4 animate-pulse text-blue-500" /> Sniffing file type, extracting sheets…
        </p>
      )}

      {triage?.kind === 'reject' && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-red-800 dark:text-red-200">
            <strong>Cannot import this file</strong>
            <p className="mt-0.5">{triage.reason}</p>
          </div>
        </div>
      )}

      {triage && triage.kind !== 'reject' && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-emerald-800 dark:text-emerald-200">
            Extracted{' '}
            <strong>{triage.sheets.length}</strong>{' '}
            {triage.kind === 'docx-tables' ? 'table' : 'sheet'}
            {triage.sheets.length === 1 ? '' : 's'} via the{' '}
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40">
              {triage.reader}
            </span>{' '}
            reader
            {triage.kind === 'pdf' && (
              <>
                {' · confidence '}
                <span className="font-mono">{(triage.confidence * 100).toFixed(0)}%</span>
              </>
            )}
            .
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 2: Sheet picker ────────────────────────────────────────────
function SheetPickerStep({
  triage,
  grades,
  selectedIdx,
  onSelect,
  onBack,
  onNext,
}: {
  triage: TriageResult | null;
  grades: SheetGrade[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  if (!triage || triage.kind === 'reject') return null;
  const canProceed = grades[selectedIdx]?.verdict !== 'non-contact';
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-bold text-slate-900">Pick a sheet</h2>
        <p className="text-[13px] text-slate-500 mt-1">
          This workbook has {triage.sheets.length} sheets. Each was graded independently — pick
          one and continue. Sheets flagged "non-contact" can't be imported.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {grades.map((g, i) => (
          <button
            key={g.sheetName + i}
            onClick={() => onSelect(i)}
            className={cn(
              'text-left rounded-[14px] border p-4 transition-colors',
              i === selectedIdx
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 bg-white hover:border-slate-300',
              g.verdict === 'non-contact' && 'opacity-60',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">{g.sheetName}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  <span className="font-mono">{g.dataRowCount}</span> rows ·{' '}
                  <span className="font-mono">{g.headerMatchedFieldCount}</span> fields matched
                </div>
              </div>
              <VerdictBadge verdict={g.verdict} confidence={g.confidence} />
            </div>
            <p className="text-[11px] text-slate-500 mt-2 line-clamp-2">{g.reason}</p>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 focus:outline-none focus:text-slate-700 dark:focus:text-slate-200"
        >
          {/* IMP-5 (QA4 · 2026-09-29): visible "Back" on every step.
              onBack here reset()s the wizard to Upload after the
              discard-decisions guard, so semantically it IS Back;
              relabelled from "Cancel" for consistency with the other
              steps' footers. */}
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          Continue <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict, confidence }: { verdict: SheetGrade['verdict']; confidence: number }) {
  const cfg = {
    auto: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'READY' },
    manual: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'NEEDS REVIEW' },
    headerless: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'EMAIL ONLY' },
    'non-contact': { bg: 'bg-slate-100', text: 'text-slate-500', label: 'NOT CONTACTS' },
  }[verdict];
  return (
    <span
      className={cn(
        'text-[11px] font-bold tracking-wide rounded-[5px] px-2 py-0.5 whitespace-nowrap',
        cfg.bg,
        cfg.text,
      )}
      title={`Confidence ${(confidence * 100).toFixed(0)}%`}
    >
      {cfg.label}
    </span>
  );
}

// ─── Step 3: Column mapping + preset dropdown ────────────────────────
function MapStep({
  sheet,
  grade,
  mapping,
  onChange,
  presets,
  onApplyPreset,
  onSavePreset,
  onBack,
  onNext,
  isBusy,
}: {
  sheet: ExtractedSheet;
  grade: SheetGrade;
  mapping: ContactsMapping;
  onChange: (m: ContactsMapping) => void;
  presets: MappingPreset[];
  onApplyPreset: (p: MappingPreset) => void;
  onSavePreset: (name: string) => Promise<void>;
  onBack: () => void;
  onNext: () => void;
  isBusy: boolean;
}) {
  const headerCells = grade.headerCells;
  const [presetName, setPresetName] = useState('');

  // Which presets can safely apply to this sheet? A preset applies when
  // every header it references exists in the sheet.
  // QA4 R2 IMP-8 — a preset value may be a list of headers; every one
  // of them has to be present for the preset to apply cleanly.
  const applicablePresets = useMemo(() => {
    const set = new Set(headerCells.filter(Boolean));
    return presets.filter((p) =>
      Object.values(p.mapping).every((value) => {
        const headers = mapHeaderList(value);
        if (headers.length === 0) return true;
        return headers.every((h) => set.has(h));
      }),
    );
  }, [presets, headerCells]);

  // QA4 R2 IMP-8 — a field value can be a single header or a list;
  // canProceed just needs "at least one header on any contact-anchor field".
  const canProceed = mapHeaderList(mapping.email).length > 0
    || mapHeaderList(mapping.phone).length > 0
    || mapHeaderList(mapping.mobile).length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">Map columns for "{sheet.name}"</h2>
          <p className="text-[13px] text-slate-500 mt-1">
            <span className="font-mono">{grade.dataRowCount}</span> data rows.
            The wizard filled in what it could — override any row you disagree with. A row commits
            when the source has a <strong>name AND (email OR phone)</strong>.
          </p>
        </div>
        <VerdictBadge verdict={grade.verdict} confidence={grade.confidence} />
      </div>

      {applicablePresets.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-white p-4 space-y-2">
          <div className="text-[13px] font-semibold text-slate-700 flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-blue-500" /> Apply a saved preset
          </div>
          <div className="flex flex-wrap gap-2">
            {applicablePresets.map((p) => (
              <button
                key={p.id}
                onClick={() => onApplyPreset(p)}
                className="inline-flex items-center gap-1 rounded-[7px] border border-slate-200 bg-white hover:border-blue-500 hover:bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                title={p.description ?? ''}
              >
                {p.name}
                {p.isSystem && (
                  <span className="ml-1 text-[11px] font-medium text-blue-600">·system</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-[14px] border border-slate-200 bg-white divide-y divide-slate-100">
        {CONTACT_FIELDS.map((field) => {
          // QA4 R2 IMP-8 — a field may be fed by N source columns.
          // The first selector is always shown; "+ add another source"
          // appends an extra selector whose contribution the classifier
          // merges by content. Removing a row via its "— skip —" option
          // collapses the mapping back to a single header for backward
          // compatibility with old presets.
          const headers = mapHeaderList(mapping[field]);
          const rows = headers.length > 0 ? headers : [''];
          return (
            <div key={field} className="grid grid-cols-[180px_1fr] items-start gap-4 px-4 py-3">
              <div className="pt-2">
                <label htmlFor={`contacts-map-${field}-0`} className="text-[13px] font-semibold text-slate-700">
                  {CONTACT_FIELD_LABELS[field]}
                </label>
                {headers.length > 1 && (
                  <div className="text-[11px] font-medium text-blue-600 mt-0.5">
                    {headers.length} sources merged
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {rows.map((currentHeader, rowIdx) => {
                  const selectId = `contacts-map-${field}-${rowIdx}`;
                  const isExtra = rowIdx > 0;
                  return (
                    <div key={rowIdx} className="flex items-center gap-2">
                      <select
                        id={selectId}
                        value={currentHeader}
                        onChange={(e) =>
                          onChange({
                            ...mapping,
                            [field]: setMappingHeaderAt(headers, rowIdx, e.target.value),
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none"
                      >
                        <option value="">— skip —</option>
                        {headerCells.filter(Boolean).map((h, i) => (
                          <option key={`${h}-${i}`} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                      {isExtra && (
                        <button
                          type="button"
                          onClick={() =>
                            onChange({
                              ...mapping,
                              [field]: removeMappingHeaderAt(headers, rowIdx),
                            })
                          }
                          className="text-[11px] font-semibold text-slate-500 hover:text-red-600 px-2 py-1"
                          aria-label={`Remove source ${rowIdx + 1} from ${CONTACT_FIELD_LABELS[field]}`}
                          title="Remove this source column"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  );
                })}
                {headers.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        ...mapping,
                        [field]: [...headers, ''],
                      })
                    }
                    className="text-[11px] font-semibold text-blue-600 hover:text-blue-700"
                  >
                    + add another source
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-[14px] border border-slate-200 bg-white p-4">
        <div className="text-[13px] font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
          <SaveIcon className="h-4 w-4 text-slate-500" aria-hidden="true" /> Save this mapping as a preset
        </div>
        <div className="flex gap-2 items-end">
          <TextField
            className="flex-1"
            label={<span className="sr-only">Preset name</span>}
            name="import-preset-name"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Preset name — e.g. Acme Q3 vendor list"
            hint="Presets are shared across the org — the next sheet with the same headers becomes zero-click."
          />
          <button
            type="button"
            disabled={!presetName.trim() || Object.keys(mapping).length === 0}
            onClick={async () => {
              await onSavePreset(presetName.trim());
              setPresetName('');
            }}
            className="mb-6 rounded-lg border border-slate-200 hover:border-slate-400 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 disabled:opacity-50"
          >
            Save preset
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-semibold text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed || isBusy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {isBusy ? 'Resolving…' : 'Preview'} <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Preview + conflict resolution ───────────────────────────
function PreviewStep({
  preview,
  sheetName,
  decisions,
  orgTypes,
  orgOverrides,
  orgDeleted,
  orgDeleteMode,
  personOrgOverrides,
  conflictResolutions,
  onOrgTypeChange,
  onOrgOverride,
  onOrgDelete,
  onOrgDeleteUndo,
  onMovePerson,
  onConflictResolve,
  userCreatedOrgs,
  onCreateOrg,
  onDecide,
  onOverride,
  attachToProjectId,
  onAttachProjectChange,
  projectRoleId,
  onProjectRoleChange,
  roleTypes,
  roleTypesLoading,
  onBack,
  onCommit,
  isBusy,
}: {
  preview: SheetPreview;
  sheetName: string;
  decisions: Record<string, RowDecision>;
  /** QA4 R2b ORG-3 — per-batchOrgKey role code chosen by the reviewer. */
  orgTypes: Record<string, string>;
  /** QA4 E2 — inline name / domain overrides per batchOrgKey.
   * QA4 IW-1 (2026-09-30) — extended to carry the full BP field set. */
  orgOverrides: Record<string, OrgOverrideValues>;
  /** QA4 E3 — reviewer-deleted orgs + their cascade mode. */
  orgDeleted: Set<string>;
  orgDeleteMode: Record<string, 'cascade' | 'keep-people'>;
  /** QA4 E4 — per-row target org key (null → individuals). */
  personOrgOverrides: Record<number, string | null>;
  /** QA4 E5 — per-record per-field conflict choice. */
  conflictResolutions: Record<string, Record<string, 'existing' | 'imported'>>;
  onOrgTypeChange: (batchOrgKey: string, code: string | null) => void;
  onOrgOverride: (batchOrgKey: string, patch: Partial<OrgOverrideValues>) => void;
  onOrgDelete: (batchOrgKey: string, mode: 'cascade' | 'keep-people') => void;
  onOrgDeleteUndo: (batchOrgKey: string) => void;
  onMovePerson: (rowIndex: number, targetKey: string | null) => void;
  onConflictResolve: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
  /** QA4 E6 (2026-09-29) — user-created orgs (seeded empty groups). */
  userCreatedOrgs: Array<{ key: string; name: string; domain?: string }>;
  onCreateOrg: (name: string, domain?: string) => string;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
  onOverride: (rowIndex: number, field: OverrideField, value: string | null | undefined) => void;
  attachToProjectId: number | null;
  onAttachProjectChange: (id: number | null) => void;
  projectRoleId: number | null;
  onProjectRoleChange: (id: number | null) => void;
  roleTypes: ProjectRoleTypeLite[];
  roleTypesLoading: boolean;
  onBack: () => void;
  onCommit: () => void;
  isBusy: boolean;
}) {
  const s = preview.summary;
  // People UX U4 (P-19) · 2026-09-27 — commit gate: split total conflicts
  // (informational) from unresolved conflicts (blocks commit until the
  // user picks skip / create / link on each).
  const decisionKeyFor = (rowIndex: number) => `${sheetName}::${rowIndex}`;
  const isRowResolved = (d: DedupDecision) => {
    if (d.org.action !== 'conflict') return true;
    const dec = decisions[decisionKeyFor(d.sourceRowIndex)];
    return !!dec?.orgAction && dec.orgAction !== 'conflict';
  };
  const totalConflicts = preview.decisions.filter((d) => d.org.action === 'conflict').length;
  const unresolvedConflicts = preview.decisions.filter((d) => !isRowResolved(d)).length;
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const zeroClickEligible = s.eligible === s.totalRows && s.orgConflicts === 0;

  // Rows to show — filtered when the toggle is on. Resolved rows drop
  // out too (their conflict is settled) so the filtered list shows the
  // remaining work to do.
  const visibleDecisions = conflictsOnly
    ? preview.decisions.filter((d) => d.org.action === 'conflict')
    : preview.decisions;
  const rowByIndex = useMemo(() => {
    const m = new Map<number, SheetPreview['resolvedRows'][number]>();
    for (const r of preview.resolvedRows) m.set(r.sourceRowIndex, r);
    return m;
  }, [preview.resolvedRows]);

  // QA4 R2b ORG-6 — reviewer-marked skips subtract from the effective
  // "rows that will land". Displayed inline on the summary tiles and
  // used as the commit gate.
  const skippedCount = useMemo(
    () => preview.decisions.filter((d) => decisions[decisionKeyFor(d.sourceRowIndex)]?.skipped).length,
    [preview.decisions, decisions, sheetName],
  );
  const effectiveEligible = Math.max(0, s.eligible - skippedCount);

  // QA4 RD-1 (2026-09-29) — group the batch by batchOrgKey. Commit
  // creates the org once per key; this list drives the unified
  // grouped review below (one card per org, people nested under it,
  // plus an "Individuals (no organization)" bucket for the rest).
  //
  // Label sanitisation (RD-3): a group's label is NEVER an email, a
  // dash, or a bare single character — the raw `values.company` may
  // hold any of those (a real xlsx sometimes drops `-` into the
  // company cell). We fall through to `@domain` and finally to the
  // matched BP name when the raw string fails plausibility.
  const orgGroups = useMemo<OrgGroup[]>(() => {
    const map = new Map<string, OrgGroup>();
    // Small helper — apply an override once so a group's label/domain
    // reflects the reviewer's inline edit immediately.
    const applyOverride = (g: OrgGroup) => {
      const o = orgOverrides[g.key];
      if (!o) return;
      if (o.name && o.name.trim()) g.label = o.name.trim();
      if (o.domain && o.domain.trim()) g.domain = o.domain.trim().toLowerCase();
    };
    for (const d of preview.decisions) {
      // Respect user-skipped rows for the person count so the panel
      // matches what the commit will actually write.
      const dec = decisions[decisionKeyFor(d.sourceRowIndex)];
      const isSkipped = !!dec?.skipped;
      // QA4 E4 — a user-driven move overrides the dedup batch key.
      // `null` moves the row to Individuals (its own single-row key).
      const rawKey = d.batchOrgKey ?? `__row:${d.sourceRowIndex}`;
      const override = personOrgOverrides[d.sourceRowIndex];
      const key = override === undefined
        ? rawKey
        : override === null
          ? `__row:${d.sourceRowIndex}`
          : override;
      const existing = map.get(key);
      const isMatchedExisting =
        d.org.action === 'link' ||
        (d.org.action === 'create' && !!d.org.matchedBpId) ||
        (key.startsWith('bp:') || d.org.matchReason === 'domain' || d.org.matchReason === 'name');
      const cleanCompany = isPlausibleCompanyDisplay(d.values.company) ? d.values.company! : null;
      const initialLabel =
        d.org.matchedBpName ??
        cleanCompany ??
        (d.domain ? `@${d.domain}` : `Row ${d.sourceRowIndex}`);
      if (!existing) {
        // A row without a batchOrgKey OR that resolves to a name key
        // that starts with `__row:` is an individual (no groupable
        // firm identity). Domain-keyed rows are always org groups
        // even when no company text landed (the fallback `@<domain>`
        // label carries the identity forward).
        const isOrgKey = key.startsWith('bp:') || key.startsWith('domain:') || key.startsWith('name:');
        map.set(key, {
          key,
          label: initialLabel,
          domain: d.domain ?? null,
          matchedBpId: d.org.matchedBpId ?? null,
          isNew: !isMatchedExisting && !d.org.matchedBpId,
          people: [],
          personCount: 0,
          skippedCount: 0,
          hasBatchKey: !key.startsWith('__row:'),
          isIndividual: !isOrgKey,
        });
      }
      const g = map.get(key)!;
      // Promote the label whenever we see a "better" candidate: a
      // real company name beats an `@domain` fallback (which itself
      // beats the placeholder Row label). Never regress to an
      // implausible cell value.
      if (cleanCompany && (!g.label.includes(' ') || g.label.startsWith('@') || g.label.startsWith('Row '))) {
        g.label = cleanCompany;
      }
      g.people.push({ decision: d, skipped: isSkipped });
      if (isSkipped) g.skippedCount++;
      else g.personCount++;
    }
    // QA4 E6 — seed empty synthetic groups for user-created orgs so
    // they appear in the org list + moveTargets even before any
    // person has been assigned to them. Skipped when a real decision
    // already registered the same key (would only happen if a person
    // had already been moved to it in this render).
    for (const u of userCreatedOrgs) {
      if (map.has(u.key)) continue;
      map.set(u.key, {
        key: u.key,
        label: u.name,
        domain: u.domain ?? null,
        matchedBpId: null,
        isNew: true,
        people: [],
        personCount: 0,
        skippedCount: 0,
        hasBatchKey: true,
        isIndividual: false,
      });
    }
    // Apply E2 overrides (inline org name / domain).
    for (const g of map.values()) applyOverride(g);
    return [...map.values()].sort((a, b) => {
      // Individuals bucket sinks to the bottom; among orgs, larger
      // groups float to the top so the reviewer sees "1 org · 4
      // people" before "1 org · 1 person".
      if (a.isIndividual !== b.isIndividual) return a.isIndividual ? 1 : -1;
      return b.personCount - a.personCount;
    });
  }, [preview.decisions, decisions, sheetName, personOrgOverrides, orgOverrides, userCreatedOrgs]);

  // QA4 R2b ORG-3 gate — every NEW org must have a role code picked
  // (matched-existing orgs never appear in this list). Commit stays
  // disabled until the reviewer has typed every one. E3 excludes
  // orgs the reviewer deleted — no type needed for a card that will
  // be dropped at commit.
  const newOrgGroups = orgGroups.filter(
    (g) => g.isNew && g.hasBatchKey && g.personCount > 0 && !g.isIndividual && !orgDeleted.has(g.key),
  );
  const untypedNewOrgs = newOrgGroups.filter((g) => !orgTypes[g.key]).length;
  // QA4 E6 (2026-09-29) — every person must belong to an org before
  // commit. Count kept-people rows currently sitting in the
  // Individuals bucket AND still live (not skipped, not on a deleted
  // org). "Kept" means: no `skipped` decision AND not on a deleted
  // org (cascade would drop them; keep-people moves them here, which
  // means the reviewer has to reassign each one before commit).
  const orphanCount = useMemo(() => {
    let n = 0;
    for (const g of orgGroups) {
      if (!g.isIndividual) continue;
      for (const p of g.people) {
        if (p.skipped) continue;
        // Below-contract rows are skipped at commit anyway — they
        // don't need an org assignment.
        if (!p.decision.meetsMinimumContract) continue;
        n++;
      }
    }
    return n;
  }, [orgGroups]);
  // QA4 E4 — targets available to the "Move to…" dropdown + the
  // drag/drop targets. Include every non-deleted org card + a
  // dedicated "Individuals" sink. Kept as `null` for individuals so
  // the reducer can distinguish an unset override from "move to
  // individuals".
  const moveTargets = useMemo<Array<{ key: string | null; label: string; domain?: string | null }>>(() => {
    const list: Array<{ key: string | null; label: string; domain?: string | null }> = [];
    for (const g of orgGroups) {
      if (g.isIndividual) continue;
      if (orgDeleted.has(g.key)) continue;
      list.push({ key: g.key, label: g.label, domain: g.domain });
    }
    list.push({ key: null, label: '— Individuals (no organization) —' });
    return list;
  }, [orgGroups, orgDeleted]);

  // Load org role types (customer / supplier / consultant / partner /
  // …) once; shared with the ORG-3 selector on each row of the panel.
  const orgRoleTypesQuery = useQuery({
    queryKey: ['admin/partner-types/role-types'],
    staleTime: 10 * 60 * 1000,
    queryFn: () =>
      client
        .get('/admin/partner-types/role-types')
        .then((r) => (r.data?.data ?? r.data ?? []) as PartnerRoleTypeLite[]),
  });
  const orgRoleTypes = useMemo(
    () =>
      (orgRoleTypesQuery.data ?? []).filter(
        (rt) => rt.appliesToKind === 'organization' || rt.appliesToKind === 'any',
      ),
    [orgRoleTypesQuery.data],
  );

  // QA4 IW-2 (2026-09-30) — default NEW-org type is Partner.
  // Auto-seed the `partner` PartnerRoleType.code on every new-org
  // group the first time it enters the list. A `Set` ref tracks
  // which keys we've already seeded so if the reviewer clears the
  // pick (setting the state entry back to undefined) we DON'T
  // re-seed it on the next render — an explicit clear is honoured
  // (the commit backend falls back to `partner` anyway, matching
  // this default).
  const seededPartnerKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (orgRoleTypes.length === 0) return;
    const partnerCode = orgRoleTypes.find((rt) => rt.code === 'partner')?.code;
    if (!partnerCode) return;
    for (const g of newOrgGroups) {
      if (seededPartnerKeys.current.has(g.key)) continue;
      seededPartnerKeys.current.add(g.key);
      if (!(g.key in orgTypes)) {
        onOrgTypeChange(g.key, partnerCode);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRoleTypes, newOrgGroups.length]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Total rows" value={s.totalRows} />
        {/* Effective eligible after ORG-6 reviewer skips subtract. */}
        <SummaryTile label="Eligible" value={effectiveEligible} tone="ok" />
        <SummaryTile label="Missing email or phone" value={s.belowContract} tone={s.belowContract > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Conflicts" value={s.orgConflicts} tone={s.orgConflicts > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Orgs · create" value={s.orgsToCreate} tone="ok" />
        <SummaryTile label="Orgs · link" value={s.orgsToLink} tone="info" />
        <SummaryTile label="Contacts · create" value={s.contactsToCreate} tone="ok" />
        <SummaryTile
          label={skippedCount > 0 ? 'Removed by reviewer' : 'Contacts · link'}
          value={skippedCount > 0 ? skippedCount : s.contactsToLink}
          tone={skippedCount > 0 ? 'warn' : 'info'}
        />
      </div>

      {(s.emailSplitRows > 0 || s.phoneSplitRows > 0 || s.companyFilledRows > 0 || s.disciplineFilledRows > 0) && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/30 p-3 flex items-start gap-2 text-[12px] text-blue-800 dark:text-blue-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>Structural fixes applied (visible per row below):</strong>{' '}
            {[
              s.emailSplitRows && `${s.emailSplitRows} emails split`,
              s.phoneSplitRows && `${s.phoneSplitRows} phones split`,
              s.companyFilledRows && `${s.companyFilledRows} companies inherited`,
              s.disciplineFilledRows && `${s.disciplineFilledRows} disciplines inherited`,
              s.emailSplitFailedRows && `${s.emailSplitFailedRows} email cells failed split`,
              s.phoneSplitFailedRows && `${s.phoneSplitFailedRows} phone cells failed split`,
            ]
              .filter(Boolean)
              .join(' · ')}
            .
          </div>
        </div>
      )}

      {/* QA4 R2 ORG-5 (2026-09-29) — internal-employee skip notice.
          Rows whose email is on the home org's owned domain are dropped
          before dedup so they never surface as importable external
          contacts. The line makes the drop visible so nothing looks
          like it silently vanished. */}
      {(s.internalSkipped ?? 0) > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-3 flex items-start gap-2 text-[12px] text-slate-700 dark:text-slate-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>{s.internalSkipped} internal row{s.internalSkipped === 1 ? '' : 's'} skipped</strong>{' '}
            (home domain{(s.homeOrgDomains?.length ?? 0) > 0 ? `: ${s.homeOrgDomains!.join(', ')}` : ''}).
            <span className="text-slate-500 dark:text-slate-400"> These are AMEC employees, not external contacts, so they were dropped from the external import.</span>
          </div>
        </div>
      )}

      {zeroClickEligible && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3 flex items-center gap-2 text-[12px] text-emerald-800 dark:text-emerald-200">
          <Sparkles className="h-4 w-4" />
          <div>
            <strong>0-click eligible</strong> — every row meets the minimum contract and no
            conflicts remain. Click Commit to import.
          </div>
        </div>
      )}

      {/* People UX U4 (P-19) · 2026-09-27 — conflicts-only toggle + inline
          counter above the row list. */}
      {totalConflicts > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setConflictsOnly((v) => !v)}
            aria-pressed={conflictsOnly}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors focus:outline-none',
              conflictsOnly
                ? 'border-amber-400 bg-amber-50 text-amber-800 hover:border-amber-500 focus:border-amber-600 dark:border-amber-500/70 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:border-amber-400'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500 dark:focus:border-blue-400',
            )}
          >
            Conflicts ({totalConflicts})
          </button>
          {unresolvedConflicts > 0 ? (
            <span className="text-[12px] text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              <strong>{unresolvedConflicts}</strong>&nbsp;still need a decision
            </span>
          ) : (
            <span className="text-[12px] text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All conflicts resolved
            </span>
          )}
        </div>
      )}

      {/* QA4 RD-1 (2026-09-29) · Unified grouped review — one screen
          replaces the ORG-2 two-screen split (Organizations panel +
          flat Preview table). Each org is a card with its people
          nested underneath; rows with no groupable firm identity
          collect under "Individuals (no organization)". */}
      <GroupedReview
        groups={orgGroups}
        rowByIndex={rowByIndex}
        decisions={decisions}
        decisionKeyFor={decisionKeyFor}
        conflictsOnly={conflictsOnly}
        orgTypes={orgTypes}
        orgOverrides={orgOverrides}
        orgDeleted={orgDeleted}
        orgDeleteMode={orgDeleteMode}
        conflictResolutions={conflictResolutions}
        onOrgTypeChange={onOrgTypeChange}
        onOrgOverride={onOrgOverride}
        onOrgDelete={onOrgDelete}
        onOrgDeleteUndo={onOrgDeleteUndo}
        onMovePerson={onMovePerson}
        onConflictResolve={onConflictResolve}
        onCreateOrg={onCreateOrg}
        moveTargets={moveTargets}
        orgRoleTypes={orgRoleTypes}
        orgRoleTypesLoading={orgRoleTypesQuery.isLoading}
        untypedNewOrgs={untypedNewOrgs}
        orphanCount={orphanCount}
        onDecide={onDecide}
        onOverride={onOverride}
      />

      <ProjectAttachPanel
        attachToProjectId={attachToProjectId}
        onAttachProjectChange={onAttachProjectChange}
        projectRoleId={projectRoleId}
        onProjectRoleChange={onProjectRoleChange}
        roleTypes={roleTypes}
        roleTypesLoading={roleTypesLoading}
      />

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 focus:outline-none focus:text-slate-700 dark:focus:text-slate-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={
            isBusy
            || effectiveEligible === 0
            || unresolvedConflicts > 0
            || untypedNewOrgs > 0
            || orphanCount > 0
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50 focus:outline-none focus:border-blue-400"
        >
          {isBusy
            ? 'Committing…'
            : unresolvedConflicts > 0
              ? `Resolve ${unresolvedConflicts} conflict${unresolvedConflicts === 1 ? '' : 's'} to continue`
              : untypedNewOrgs > 0
                ? `Classify ${untypedNewOrgs} organization${untypedNewOrgs === 1 ? '' : 's'} to continue`
                : orphanCount > 0
                  ? `Assign ${orphanCount} ${orphanCount === 1 ? 'person' : 'people'} to an organization to continue`
                  : `Commit ${effectiveEligible} rows`}{' '}
          {unresolvedConflicts === 0 && untypedNewOrgs === 0 && orphanCount === 0 && <ArrowRight className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

// ─── QA4 RD-1 (2026-09-29) · Unified grouped review ──────────────────
/**
 * Replaces the ORG-2 two-screen split (a separate Organizations panel
 * PLUS a flat Row-by-row Preview table). One hierarchical view:
 *
 *   • one card per organization — org header carries LINK/NEW badge
 *     (RD-2), domain, person-count, and (for NEW orgs) the role-type
 *     picker (ORG-3). Expanding the card reveals the org's people as
 *     rows in a nested table (no Company column — that identity is the
 *     card).
 *   • "Individuals (no organization)" — one final section for rows
 *     with no groupable firm identity (personal domain + no company,
 *     name-only key with a single row). Rendered as the classic per-
 *     row table WITH the Company column so the reviewer can still spot
 *     a stray company name they may want to edit.
 *
 * Person rows carry LINK/NEW badges of their own (RD-2, matched by
 * email). The commit gate ("N need a type") counts only NEW org cards
 * that have not been classified yet — an existing (LINK) org keeps
 * its role, so it never appears in the gate.
 */
function GroupedReview({
  groups,
  rowByIndex,
  decisions,
  decisionKeyFor,
  conflictsOnly,
  orgTypes,
  orgOverrides,
  orgDeleted,
  orgDeleteMode,
  conflictResolutions,
  onOrgTypeChange,
  onOrgOverride,
  onOrgDelete,
  onOrgDeleteUndo,
  onMovePerson,
  onConflictResolve,
  onCreateOrg,
  moveTargets,
  orgRoleTypes,
  orgRoleTypesLoading,
  untypedNewOrgs,
  orphanCount,
  onDecide,
  onOverride,
}: {
  groups: OrgGroup[];
  rowByIndex: Map<number, ResolvedRow>;
  decisions: Record<string, RowDecision>;
  decisionKeyFor: (rowIndex: number) => string;
  conflictsOnly: boolean;
  orgTypes: Record<string, string>;
  orgOverrides: Record<string, OrgOverrideValues>;
  orgDeleted: Set<string>;
  orgDeleteMode: Record<string, 'cascade' | 'keep-people'>;
  conflictResolutions: Record<string, Record<string, 'existing' | 'imported'>>;
  onOrgTypeChange: (batchOrgKey: string, code: string | null) => void;
  onOrgOverride: (batchOrgKey: string, patch: Partial<OrgOverrideValues>) => void;
  onOrgDelete: (batchOrgKey: string, mode: 'cascade' | 'keep-people') => void;
  onOrgDeleteUndo: (batchOrgKey: string) => void;
  onMovePerson: (rowIndex: number, targetKey: string | null) => void;
  onConflictResolve: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
  onCreateOrg: (name: string, domain?: string) => string;
  moveTargets: Array<{ key: string | null; label: string; domain?: string | null }>;
  orgRoleTypes: PartnerRoleTypeLite[];
  orgRoleTypesLoading: boolean;
  untypedNewOrgs: number;
  orphanCount: number;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
  onOverride: (rowIndex: number, field: OverrideField, value: string | null | undefined) => void;
}) {
  const orgs = groups.filter((g) => !g.isIndividual);
  const individuals = groups.filter((g) => g.isIndividual);
  // Flatten the individuals bucket into a single list of decisions so
  // the section can render as one continuous table.
  const individualPeople = useMemo(
    () =>
      individuals.flatMap((g) =>
        g.people.map((p) => ({ decision: p.decision, skipped: p.skipped })),
      ),
    [individuals],
  );
  // Apply the "conflicts only" filter to BOTH the org cards' people
  // lists and the individuals section — it lives outside this
  // component but the parent passes it in so we can filter once here.
  const filterPeople = (
    people: Array<{ decision: DedupDecision; skipped: boolean }>,
  ) =>
    conflictsOnly ? people.filter((p) => p.decision.org.action === 'conflict') : people;

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Default: expand every group so the reviewer sees the people
    // right away. Collapsing is a per-org affordance for very large
    // files (a workbook with 40+ orgs).
    return new Set(orgs.map((g) => g.key));
  });
  const toggle = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  useEffect(() => {
    // Re-expand the individuals bucket + auto-expand any newly-
    // introduced org (adding rows via Back → Map → Preview).
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const g of orgs) if (!next.has(g.key)) next.add(g.key);
      return next;
    });
  }, [orgs.length]);

  const newCount = orgs.filter((g) => g.isNew).length;
  const linkCount = orgs.filter((g) => !g.isNew).length;

  // QA4 E4 (2026-09-29) — DnD sensors. A short activation distance
  // keeps in-cell clicks (chevrons, buttons, inline text edits) from
  // triggering a drag by accident.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const rowIndex = active.data.current?.rowIndex as number | undefined;
    const targetKey = over.data.current?.targetKey as string | null | undefined;
    if (typeof rowIndex !== 'number') return;
    if (targetKey === undefined) return; // no valid target
    onMovePerson(rowIndex, targetKey);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
    <div className="space-y-3">
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
          <Building2 className="h-4 w-4 text-indigo-500 dark:text-indigo-400" aria-hidden="true" />
          <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
            Organizations ({orgs.length})
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {newCount > 0 && `${newCount} new`}
            {newCount > 0 && linkCount > 0 && ' · '}
            {linkCount > 0 && `${linkCount} link${linkCount === 1 ? '' : 's'}`}
          </span>
          {untypedNewOrgs > 0 && (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              {untypedNewOrgs} need a type
            </span>
          )}
          {conflictsOnly && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Conflicts only
            </span>
          )}
        </div>
        {orgs.length === 0 ? (
          <div className="px-3 py-6 text-[12px] italic text-slate-400 dark:text-slate-500 text-center">
            No organizations detected in this file.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {orgs.map((g) => {
              const visiblePeople = filterPeople(g.people);
              const isExp = expanded.has(g.key);
              const isDeleted = orgDeleted.has(g.key);
              return (
                <OrgCard
                  key={g.key}
                  group={g}
                  isExpanded={isExp}
                  onToggle={() => toggle(g.key)}
                  visiblePeople={visiblePeople}
                  totalPeople={g.people.length}
                  rowByIndex={rowByIndex}
                  decisions={decisions}
                  decisionKeyFor={decisionKeyFor}
                  orgTypes={orgTypes}
                  onOrgTypeChange={onOrgTypeChange}
                  orgOverride={orgOverrides[g.key]}
                  onOrgOverride={onOrgOverride}
                  isDeleted={isDeleted}
                  deleteMode={orgDeleteMode[g.key]}
                  onOrgDelete={onOrgDelete}
                  onOrgDeleteUndo={onOrgDeleteUndo}
                  onMovePerson={onMovePerson}
                  onConflictResolve={onConflictResolve}
                  conflictResolutions={conflictResolutions}
                  moveTargets={moveTargets}
                  orgRoleTypes={orgRoleTypes}
                  orgRoleTypesLoading={orgRoleTypesLoading}
                  onDecide={onDecide}
                  onOverride={onOverride}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* QA4 E6 (2026-09-29) — orphan gate banner. Every kept person
          must have an org before commit; the banner names the count
          and points at the Individuals section below. */}
      {orphanCount > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 flex items-start gap-2 text-[12px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>
              {orphanCount} {orphanCount === 1 ? 'person is' : 'people are'} still without an organization.
            </strong>{' '}
            Assign each one to an existing org or create a new one below — the commit is blocked until every person belongs to a firm.
          </div>
        </div>
      )}

      {/* Individuals section — same table shape but WITH Company. */}
      {individualPeople.length > 0 && (
        <IndividualsSection
          people={filterPeople(individualPeople)}
          totalPeople={individualPeople.length}
          rowByIndex={rowByIndex}
          decisions={decisions}
          decisionKeyFor={decisionKeyFor}
          onDecide={onDecide}
          onOverride={onOverride}
          onMovePerson={onMovePerson}
          onCreateOrg={onCreateOrg}
          moveTargets={moveTargets}
          conflictResolutions={conflictResolutions}
          onConflictResolve={onConflictResolve}
        />
      )}
    </div>
    </DndContext>
  );
}

/**
 * QA4 RD-1 · one org card. Header carries the LINK/NEW badge (RD-2),
 * the org label (sanitised — never an email/dash), the domain, and
 * the type picker for new orgs. When expanded, the card body is a
 * compact table listing every person the row loop would attach
 * `worker_of` this org.
 */
function OrgCard({
  group,
  isExpanded,
  onToggle,
  visiblePeople,
  totalPeople,
  rowByIndex,
  decisions,
  decisionKeyFor,
  orgTypes,
  onOrgTypeChange,
  orgOverride,
  onOrgOverride,
  isDeleted,
  deleteMode,
  onOrgDelete,
  onOrgDeleteUndo,
  onMovePerson,
  onConflictResolve,
  conflictResolutions,
  moveTargets,
  orgRoleTypes,
  orgRoleTypesLoading,
  onDecide,
  onOverride,
}: {
  group: OrgGroup;
  isExpanded: boolean;
  onToggle: () => void;
  visiblePeople: Array<{ decision: DedupDecision; skipped: boolean }>;
  totalPeople: number;
  rowByIndex: Map<number, ResolvedRow>;
  decisions: Record<string, RowDecision>;
  decisionKeyFor: (rowIndex: number) => string;
  orgTypes: Record<string, string>;
  onOrgTypeChange: (batchOrgKey: string, code: string | null) => void;
  orgOverride: OrgOverrideValues | undefined;
  onOrgOverride: (batchOrgKey: string, patch: Partial<OrgOverrideValues>) => void;
  isDeleted: boolean;
  deleteMode: 'cascade' | 'keep-people' | undefined;
  onOrgDelete: (batchOrgKey: string, mode: 'cascade' | 'keep-people') => void;
  onOrgDeleteUndo: (batchOrgKey: string) => void;
  onMovePerson: (rowIndex: number, targetKey: string | null) => void;
  onConflictResolve: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
  conflictResolutions: Record<string, Record<string, 'existing' | 'imported'>>;
  moveTargets: Array<{ key: string | null; label: string; domain?: string | null }>;
  orgRoleTypes: PartnerRoleTypeLite[];
  orgRoleTypesLoading: boolean;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
  onOverride: (rowIndex: number, field: OverrideField, value: string | null | undefined) => void;
}) {
  const pickedCode = orgTypes[group.key] ?? '';
  const needsPick = group.isNew && group.hasBatchKey && !pickedCode && group.personCount > 0 && !isDeleted;
  const [askDelete, setAskDelete] = useState(false);
  // QA4 E4 (2026-09-29) — droppable target for the drag/drop mover.
  const { isOver, setNodeRef: setDroppableRef } = useDroppable({
    id: `drop-org-${group.key}`,
    data: { targetKey: group.key },
    disabled: isDeleted,
  });
  // QA4 E2 (2026-09-29) — inline org name / domain editors.
  const [editingName, setEditingName] = useState(false);
  const [editingDomain, setEditingDomain] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.label);
  const [domainDraft, setDomainDraft] = useState(group.domain ?? '');
  useEffect(() => setNameDraft(group.label), [group.label]);
  useEffect(() => setDomainDraft(group.domain ?? ''), [group.domain]);
  const commitName = () => {
    const t = nameDraft.trim();
    setEditingName(false);
    if (t && t !== group.label) onOrgOverride(group.key, { name: t });
  };
  const commitDomain = () => {
    const t = domainDraft.trim().toLowerCase();
    setEditingDomain(false);
    if (t !== (group.domain ?? '')) onOrgOverride(group.key, { domain: t || undefined });
  };

  return (
    <div
      ref={setDroppableRef}
      className={cn(
        'px-3 py-2.5 transition-colors',
        needsPick && 'bg-amber-50/30 dark:bg-amber-950/10',
        isDeleted && 'opacity-60 bg-slate-100/40 dark:bg-slate-800/30',
        isOver && 'bg-blue-50 dark:bg-blue-950/40 ring-2 ring-blue-400 dark:ring-blue-500 ring-inset',
      )}
    >
      <div className="flex items-start gap-2 flex-wrap">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800 shrink-0 mt-0.5"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse people' : 'Expand people'}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 text-slate-500 dark:text-slate-400 transition-transform',
              isExpanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <EntityBadge
              kind={group.isNew ? 'new' : 'link'}
              matchedName={group.matchedBpId ? group.label : null}
            />
            {/* QA4 E2 — inline editable name. Click to enter edit
                mode; Enter or blur commits, ESC cancels. Never lets an
                empty string overwrite the group's derived label — a
                clear falls back to the parsed value. */}
            {editingName ? (
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitName();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setNameDraft(group.label);
                    setEditingName(false);
                  }
                }}
                autoFocus
                className="text-[13px] font-semibold px-1.5 py-0.5 rounded-md border border-blue-400 dark:border-blue-500 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 min-w-[10rem]"
                aria-label="Edit organization name"
              />
            ) : (
              <button
                type="button"
                onClick={() => !isDeleted && setEditingName(true)}
                disabled={isDeleted}
                className={cn(
                  'text-[13px] font-semibold truncate text-left rounded px-1 py-0.5 -mx-1 -my-0.5',
                  orgOverride?.name
                    ? 'text-emerald-800 dark:text-emerald-200'
                    : 'text-slate-800 dark:text-slate-100',
                  !isDeleted && 'hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800',
                )}
                title={isDeleted ? undefined : 'Click to edit organization name'}
              >
                {group.label}
                {orgOverride?.name && (
                  <span className="ml-1 inline-block align-middle">
                    <CellTag tone="edited">edited</CellTag>
                  </span>
                )}
              </button>
            )}
            {editingDomain ? (
              <input
                type="text"
                value={domainDraft}
                onChange={(e) => setDomainDraft(e.target.value)}
                onBlur={commitDomain}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDomain();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setDomainDraft(group.domain ?? '');
                    setEditingDomain(false);
                  }
                }}
                autoFocus
                placeholder="e.g. mra.co.il"
                className="text-[11px] font-mono px-1.5 py-0.5 rounded-md border border-blue-400 dark:border-blue-500 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 min-w-[10rem]"
                aria-label="Edit organization domain"
              />
            ) : (
              <button
                type="button"
                onClick={() => !isDeleted && setEditingDomain(true)}
                disabled={isDeleted}
                className={cn(
                  'text-[11px] font-mono rounded px-1 py-0.5 -mx-1 -my-0.5',
                  orgOverride?.domain
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-slate-500 dark:text-slate-400',
                  !isDeleted && 'hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800',
                )}
                title={isDeleted ? undefined : 'Click to edit domain'}
              >
                {group.domain ? `@${group.domain}` : '+ add domain'}
              </button>
            )}
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {group.personCount} {group.personCount === 1 ? 'person' : 'people'}
              {group.skippedCount > 0 && ` · ${group.skippedCount} removed`}
            </span>
            {/* QA4 E5 — matched-existing org: show per-field diff chip
                when the row's imported values disagree with the DB. */}
            {!group.isNew && !isDeleted && group.people[0] && group.people[0].decision.org.existingFields && (
              <ConflictResolver
                recordKey={`org:${group.key}`}
                existingFields={group.people[0].decision.org.existingFields}
                importedFields={{
                  company: group.people[0].decision.values.company ?? null,
                  email: group.people[0].decision.values.email ?? null,
                  phone: group.people[0].decision.values.phone ?? null,
                  mobile: group.people[0].decision.values.mobile ?? null,
                  address: group.people[0].decision.values.address ?? null,
                  note: group.people[0].decision.values.note ?? null,
                }}
                picks={conflictResolutions[`org:${group.key}`] ?? {}}
                onPick={onConflictResolve}
                fieldOrder={[...ORG_CONFLICT_FIELDS]}
                fieldLabels={ORG_CONFLICT_LABELS}
              />
            )}
            {isDeleted && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 rounded px-1.5 py-0.5">
                deleted · {deleteMode === 'cascade' ? 'people dropped' : 'people moved to individuals'}
              </span>
            )}
          </div>
        </div>
        {group.isNew && group.hasBatchKey && !isDeleted ? (
          <select
            value={pickedCode}
            onChange={(e) => onOrgTypeChange(group.key, e.target.value || null)}
            disabled={orgRoleTypesLoading}
            aria-label={`Organization type for ${group.label}`}
            className={cn(
              'shrink-0 px-2 py-1 rounded-md border text-[12px] focus:outline-none',
              needsPick
                ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 focus:border-amber-600 dark:focus:border-amber-400'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:border-blue-500 dark:focus:border-blue-400',
            )}
          >
            <option value="">
              {orgRoleTypesLoading ? 'Loading…' : '— pick type —'}
            </option>
            {orgRoleTypes.map((rt) => (
              <option key={rt.code} value={rt.code}>
                {rt.name}
              </option>
            ))}
          </select>
        ) : !isDeleted ? (
          <span className="shrink-0 text-[11px] italic text-slate-400 dark:text-slate-500 mt-1.5">
            {group.hasBatchKey ? 'keeps existing type' : ''}
          </span>
        ) : null}
        {/* QA4 E3 — delete org. Reversible until commit. */}
        {isDeleted ? (
          <button
            type="button"
            onClick={() => onOrgDeleteUndo(group.key)}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-500 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400"
            title="Undo delete"
            aria-label="Undo delete organization"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" /> Undo
          </button>
        ) : askDelete ? (
          <div className="shrink-0 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-2 space-y-1">
            <div className="text-[11px] font-semibold text-red-800 dark:text-red-200">
              Delete this organization?
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  onOrgDelete(group.key, 'cascade');
                  setAskDelete(false);
                }}
                className="text-left text-[11px] px-1.5 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-800 dark:text-red-200 focus:outline-none focus:bg-red-100 dark:focus:bg-red-900/40"
              >
                Delete org <strong>and its people</strong>
              </button>
              <button
                type="button"
                onClick={() => {
                  onOrgDelete(group.key, 'keep-people');
                  setAskDelete(false);
                }}
                className="text-left text-[11px] px-1.5 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-800 dark:text-red-200 focus:outline-none focus:bg-red-100 dark:focus:bg-red-900/40"
              >
                Delete org, <strong>keep people</strong> as individuals
              </button>
              <button
                type="button"
                onClick={() => setAskDelete(false)}
                className="text-left text-[11px] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAskDelete(true)}
            className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md border border-transparent text-slate-400 dark:text-slate-500 hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400 focus:outline-none focus:border-red-500 dark:focus:border-red-500"
            aria-label={`Delete organization ${group.label}`}
            title="Delete organization"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* QA4 IW-1 (2026-09-30) — full BP-field editor beneath the
          header. Collapsible so the reviewer can scan a long list of
          orgs first, then expand the ones they need to complete.
          Only offered for NEW org groups; matched-existing orgs use
          E5 conflict resolution to pick per field instead. */}
      {!isDeleted && group.isNew && group.hasBatchKey && (
        <OrgDetailsEditor
          group={group}
          orgOverride={orgOverride}
          onOrgOverride={onOrgOverride}
        />
      )}
      {isExpanded && !isDeleted && (
        <div className="mt-2 ml-6 rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden">
          {visiblePeople.length === 0 ? (
            <div className="px-3 py-4 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
              {totalPeople === 0
                ? 'No people attached to this organization.'
                : 'No people match the current filter.'}
            </div>
          ) : (
            <PeopleTable
              people={visiblePeople}
              rowByIndex={rowByIndex}
              decisions={decisions}
              decisionKeyFor={decisionKeyFor}
              onDecide={onDecide}
              onOverride={onOverride}
              showCompany={false}
              onMovePerson={onMovePerson}
              moveTargets={moveTargets}
              currentGroupKey={group.key}
              conflictResolutions={conflictResolutions}
              onConflictResolve={onConflictResolve}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * QA4 IW-1 (2026-09-30) — inline BP-field editor beneath an org card.
 * A collapsible "Org details" section exposing the full set of BP-
 * level fields (companyName, taxId, email, phone, mobile, website,
 * address, notes) as editable inputs. Values live on `orgOverrides[key]`
 * and are sent to the commit path (which applies them at org-create
 * time on the freshly-created BusinessPartner row).
 */
function OrgDetailsEditor({
  group,
  orgOverride,
  onOrgOverride,
}: {
  group: OrgGroup;
  orgOverride: OrgOverrideValues | undefined;
  onOrgOverride: (batchOrgKey: string, patch: Partial<OrgOverrideValues>) => void;
}) {
  const [open, setOpen] = useState(false);
  const setValues = orgOverride ?? {};
  const editedCount = ORG_EXTRA_FIELDS.reduce(
    (n, f) => (setValues[f.key] ? n + 1 : n),
    0,
  );
  return (
    <div className="mt-2 ml-6 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800/60"
        aria-expanded={open}
        aria-label={open ? 'Collapse organization details' : 'Expand organization details'}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-slate-500 dark:text-slate-400 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
        <span className="uppercase tracking-wide">Org details</span>
        {editedCount > 0 && (
          <span className="ml-1 inline-flex items-center rounded-[4px] border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            {editedCount} edited
          </span>
        )}
        <span className="ml-auto text-[10px] font-normal text-slate-400 dark:text-slate-500">
          {open ? 'hide' : 'edit'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-2">
          {ORG_EXTRA_FIELDS.map((field) => {
            const value = setValues[field.key] ?? '';
            const inputId = `org-${group.key}-${field.key}`;
            const commonProps = {
              id: inputId,
              value,
              onChange: (
                e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
              ) => onOrgOverride(group.key, { [field.key]: e.target.value }),
              placeholder: field.type === 'url' ? 'https://…' : '—',
              className: cn(
                'w-full rounded-md border px-2 py-1 text-[12px] focus:outline-none',
                'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
                'text-slate-800 dark:text-slate-100 focus:border-blue-500 dark:focus:border-blue-400',
                setValues[field.key] && 'text-emerald-800 dark:text-emerald-200',
              ),
            } as const;
            return (
              <div key={field.key} className="flex flex-col gap-0.5 min-w-0">
                <label
                  htmlFor={inputId}
                  className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400"
                >
                  {field.label}
                </label>
                {field.type === 'multiline' ? (
                  <textarea rows={2} {...commonProps} className={cn(commonProps.className, 'resize-none')} />
                ) : (
                  <input type={field.type === 'url' ? 'url' : 'text'} {...commonProps} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * QA4 RD-1 · Individuals (no organization) section. Same PeopleTable
 * inside but WITH the Company column, since these rows have no parent
 * org context — the reviewer may want to spot a stray company text
 * that missed the classifier.
 */
function IndividualsSection({
  people,
  totalPeople,
  rowByIndex,
  decisions,
  decisionKeyFor,
  onDecide,
  onOverride,
  onMovePerson,
  onCreateOrg,
  moveTargets,
  conflictResolutions,
  onConflictResolve,
}: {
  people: Array<{ decision: DedupDecision; skipped: boolean }>;
  totalPeople: number;
  rowByIndex: Map<number, ResolvedRow>;
  decisions: Record<string, RowDecision>;
  decisionKeyFor: (rowIndex: number) => string;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
  onOverride: (rowIndex: number, field: OverrideField, value: string | null | undefined) => void;
  /** QA4 E4 / E6 — assign an individual to an existing org card. */
  onMovePerson?: (rowIndex: number, targetKey: string | null) => void;
  /** QA4 E6 — inline "Create org" affordance for orphan assignment. */
  onCreateOrg?: (name: string, domain?: string) => string;
  moveTargets?: Array<{ key: string | null; label: string; domain?: string | null }>;
  /** QA4 E5 — per-field conflict picks (kept/use imported). */
  conflictResolutions?: Record<string, Record<string, 'existing' | 'imported'>>;
  onConflictResolve?: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
}) {
  // QA4 E4 (2026-09-29) — droppable target for "move to individuals".
  const { isOver, setNodeRef: setDroppableRef } = useDroppable({
    id: 'drop-individuals',
    data: { targetKey: null },
  });
  // QA4 E6 (2026-09-29) — "Create new org" inline form.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const submitCreate = () => {
    const n = newName.trim();
    if (!n) return;
    onCreateOrg?.(n, newDomain.trim() || undefined);
    setNewName('');
    setNewDomain('');
    setCreating(false);
  };
  return (
    <div
      ref={setDroppableRef}
      className={cn(
        'rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden transition-colors',
        isOver
          ? 'border-blue-400 dark:border-blue-500 ring-2 ring-blue-400 dark:ring-blue-500'
          : 'border-slate-200 dark:border-slate-700',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
        <Info className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
          Individuals (no organization) ({totalPeople})
        </span>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          rows with no groupable firm identity (personal domain or missing company) — expand a row to assign one
        </span>
        {onCreateOrg && (
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-2 py-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:border-blue-500 focus:outline-none focus:border-blue-500"
          >
            + Create org
          </button>
        )}
      </div>
      {creating && (
        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-blue-50/50 dark:bg-blue-950/20 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">
              Name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitCreate();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCreating(false);
                }
              }}
              placeholder="e.g. Acme Studio"
              autoFocus
              className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[12px] text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 min-w-[12rem]"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">
              Domain (optional)
            </label>
            <input
              type="text"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitCreate();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCreating(false);
                }
              }}
              placeholder="e.g. acme.co.il"
              className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[12px] font-mono text-slate-700 dark:text-slate-200 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 min-w-[10rem]"
            />
          </div>
          <button
            type="button"
            onClick={submitCreate}
            disabled={!newName.trim()}
            className="rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1 disabled:opacity-50 focus:outline-none"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[12px] font-semibold text-slate-600 dark:text-slate-300 px-3 py-1 focus:outline-none"
          >
            Cancel
          </button>
        </div>
      )}
      {people.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
          {totalPeople === 0
            ? 'No individual rows in this file.'
            : 'No individuals match the current filter.'}
        </div>
      ) : (
        <PeopleTable
          people={people}
          rowByIndex={rowByIndex}
          decisions={decisions}
          decisionKeyFor={decisionKeyFor}
          onDecide={onDecide}
          onOverride={onOverride}
          showCompany={true}
          onMovePerson={onMovePerson}
          moveTargets={moveTargets}
          currentGroupKey={null}
          conflictResolutions={conflictResolutions}
          onConflictResolve={onConflictResolve}
        />
      )}
    </div>
  );
}

/**
 * QA4 RD-1 · shared person table used inside org cards + the
 * individuals section. Columns are the same set of parsed fields as
 * the retired flat PreviewTable, minus Company when rendered under an
 * org card (the card is the parent). Adds a person-side LINK/NEW
 * badge (RD-2) between Email and Job Title.
 */
function PeopleTable({
  people,
  rowByIndex,
  decisions,
  decisionKeyFor,
  onDecide,
  onOverride,
  showCompany,
  onMovePerson,
  moveTargets,
  currentGroupKey,
  conflictResolutions,
  onConflictResolve,
}: {
  people: Array<{ decision: DedupDecision; skipped: boolean }>;
  rowByIndex: Map<number, ResolvedRow>;
  decisions: Record<string, RowDecision>;
  decisionKeyFor: (rowIndex: number) => string;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
  onOverride: (rowIndex: number, field: OverrideField, value: string | null | undefined) => void;
  showCompany: boolean;
  /**
   * QA4 E4 (2026-09-29) — move a person to another org (or Individuals).
   * `null` moves them to the individuals bucket; a batchOrgKey string
   * assigns them under that org card.
   */
  onMovePerson?: (rowIndex: number, targetKey: string | null) => void;
  /** QA4 E4 — list of possible move targets (org cards + Individuals). */
  moveTargets?: Array<{ key: string | null; label: string; domain?: string | null }>;
  /** QA4 E4 — the group this table lives in, filtered out of the "Move to" list. */
  currentGroupKey?: string | null;
  /** QA4 E5 — per-field conflict picks (keep/use imported). */
  conflictResolutions?: Record<string, Record<string, 'existing' | 'imported'>>;
  onConflictResolve?: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [expandedFields, setExpandedFields] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleFields = (i: number) =>
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800/70 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <tr>
            <PreviewTh className="w-8">&nbsp;</PreviewTh>
            <PreviewTh className="w-16">Sheet row</PreviewTh>
            <PreviewTh>Discipline</PreviewTh>
            <PreviewTh>Contact</PreviewTh>
            {showCompany && <PreviewTh>Company</PreviewTh>}
            <PreviewTh>Phone</PreviewTh>
            <PreviewTh>Mobile</PreviewTh>
            <PreviewTh>Email</PreviewTh>
            <PreviewTh className="w-24">Person</PreviewTh>
            {/* QA4 IW-3 (2026-09-30) — the standalone "Office manager"
                column was dropped: an extracted office manager is a
                normal person under the org and now renders as its own
                SecondaryContactRow with its title in the Job Title
                cell, not in a dedicated column. */}
            <PreviewTh>Job Title</PreviewTh>
            <PreviewTh className="w-40">Verdict</PreviewTh>
            <PreviewTh className="w-10 text-center">&nbsp;</PreviewTh>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {people.map(({ decision: d }) => {
            const row = rowByIndex.get(d.sourceRowIndex);
            if (!row) return null;
            const rowDec = decisions[decisionKeyFor(d.sourceRowIndex)];
            const effectiveOrgAction = rowDec?.orgAction ?? d.org.action;
            const isExpanded = expanded.has(d.sourceRowIndex);
            const isFieldsExpanded = expandedFields.has(d.sourceRowIndex);
            const isSkipped = !!rowDec?.skipped;
            const secondaries = d.secondaryContacts ?? [];
            return (
              <React.Fragment key={d.sourceRowIndex}>
                <PreviewTableRow
                  dec={d}
                  row={row}
                  rowDec={rowDec}
                  effectiveOrgAction={effectiveOrgAction}
                  isExpanded={isExpanded}
                  isFieldsExpanded={isFieldsExpanded}
                  isSkipped={isSkipped}
                  showCompany={showCompany}
                  onToggleExpand={() => toggle(d.sourceRowIndex)}
                  onToggleFields={() => toggleFields(d.sourceRowIndex)}
                  onToggleSkipped={() =>
                    onDecide(d.sourceRowIndex, { skipped: !isSkipped })
                  }
                  onDecide={(patch) => onDecide(d.sourceRowIndex, patch)}
                  onOverride={(field, value) =>
                    onOverride(d.sourceRowIndex, field, value)
                  }
                  onMovePerson={onMovePerson}
                  moveTargets={moveTargets}
                  currentGroupKey={currentGroupKey}
                  conflictResolutions={conflictResolutions}
                  onConflictResolve={onConflictResolve}
                />
                {secondaries.map((s, i) => (
                  <SecondaryContactRow
                    key={`${d.sourceRowIndex}-secondary-${i}`}
                    primary={d}
                    secondary={s}
                    showCompany={showCompany}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * QA4 RD-2 (2026-09-29) — LINK / NEW chip used on both the org card
 * header and each person row. Green LINK when the commit would attach
 * to an existing BP (an emoji-free, colour-blind-safe pair); blue NEW
 * otherwise. `matchedName` shows next to LINK when there's a specific
 * record to name (e.g. `LINK · Yulian Abramovich`).
 */
function EntityBadge({
  kind,
  matchedName,
}: {
  kind: 'link' | 'new';
  matchedName?: string | null;
}) {
  if (kind === 'link') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
        title={matchedName ? `Will LINK to existing "${matchedName}"` : 'Will LINK to an existing record'}
      >
        link
        {matchedName ? (
          <span className="font-normal normal-case tracking-normal text-blue-700/80 dark:text-blue-300/80 truncate max-w-[12rem]">
            {matchedName}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
      title="Will CREATE a new record"
    >
      new
    </span>
  );
}

// ─── Project-attach panel (renders on the Preview step) ──────────────
/**
 * Optional: pick a project + role-type so each committed person is
 * attached to that project as a project_partner_role. Both fields are
 * optional; leaving them empty falls back to today's behaviour (BPs +
 * worker_of only). Spec: `docs/bm2/contacts-import-project-attach.md`
 * §"Part 1".
 */
function ProjectAttachPanel({
  attachToProjectId,
  onAttachProjectChange,
  projectRoleId,
  onProjectRoleChange: _onProjectRoleChange,
  roleTypes,
  roleTypesLoading,
}: {
  attachToProjectId: number | null;
  onAttachProjectChange: (id: number | null) => void;
  projectRoleId: number | null;
  /** QA4 IW-5 (2026-09-30) — role is locked in the wizard; setter is
   * kept in the props for the parent's default effect but the picker
   * UI never invokes it. */
  onProjectRoleChange: (id: number | null) => void;
  roleTypes: ProjectRoleTypeLite[];
  roleTypesLoading: boolean;
}) {
  const roleEnabled = attachToProjectId != null;
  // QA4 IW-5 (2026-09-30) — the wizard always attaches imported
  // contacts with "External Contact" as the project role; the picker
  // is a locked read-only chip. Look up the actual seeded row so we
  // can show its real display name (matches what the person will land
  // with on the project team). Falls back to `contact` / `consultant`
  // only if the seed migration has not run — which is unexpected on
  // staging.
  const externalContact = useMemo(() => {
    for (const code of FALLBACK_ROLE_CODES) {
      const found = roleTypes.find((rt) => rt.code === code);
      if (found) return found;
    }
    return null;
  }, [roleTypes]);

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FolderKanban className="h-4 w-4 text-indigo-500 dark:text-indigo-400" />
        <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
          Attach to project <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
        </h3>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        Pick a project to add every committed person to its team. Each row's
        <span className="font-mono px-1 text-slate-600 dark:text-slate-300">discipline</span> column becomes the
        person's <em>title on project</em>. Imported people always land on the project
        as <strong>External Contact</strong> — the role is locked here (edit it on the
        person's project card after the import if needed). Leave the project empty for a
        global import.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1 block">
            Project
          </label>
          <ProjectPickerInline
            value={attachToProjectId}
            onChange={onAttachProjectChange}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1 block">
            Role on project
          </label>
          {/* QA4 IW-5 (2026-09-30) — locked, read-only display. The
              wizard-level default effect sets projectRoleId to the
              External Contact seed id when the project is picked. */}
          <div
            role="group"
            aria-label="Role on project (locked to External Contact)"
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-[13px]',
              'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50',
              !roleEnabled && 'opacity-60',
            )}
            title="Imported contacts always land as External Contact; edit the role on the person's project card after the import."
          >
            <span className="text-slate-700 dark:text-slate-200 font-semibold truncate">
              {roleTypesLoading
                ? 'Loading…'
                : externalContact?.name ?? 'External Contact'}
            </span>
            <span
              className="ml-auto text-[10px] font-bold uppercase tracking-wide rounded-[4px] border px-1.5 py-0.5 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900"
              aria-hidden="true"
            >
              locked
            </span>
          </div>
          {!roleEnabled && (
            <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">Pick a project first.</p>
          )}
          {roleEnabled && projectRoleId == null && !externalContact && (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              The <code>external_contact</code> role-type seed is missing — commit will
              fall back to the backend resolver.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline typeahead for the attach-panel. Fetches on debounced search
 * against `/projects`, and separately fetches the currently-selected
 * project by id so a deep-linked prefill shows its real name even
 * before the user opens the dropdown.
 */
function ProjectPickerInline({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const ref = useRef<HTMLDivElement>(null);

  const listQuery = useProjects({ search: debouncedSearch || undefined, perPage: 25 });
  const projects = listQuery.data?.data ?? [];

  // Prefill support — when a project is selected but not in the search
  // results (e.g. deep-linked from a project we haven't typed the name
  // of), fetch it by id so we can render its name in the trigger.
  const selectedInList = projects.find((p) => p.id === value);
  const separateQuery = useProject(value ?? 0);
  const selected =
    selectedInList ??
    (value != null && separateQuery.data?.id === value ? separateQuery.data : null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 hover:border-slate-300 focus:border-blue-500 focus:outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FolderKanban className="h-4 w-4 text-slate-400" aria-hidden="true" />
        {selected ? (
          <span className="truncate text-left">
            {selected.name}
            {selected.number && (
              <span className="text-[11px] text-slate-400 ml-1 font-mono">
                {selected.number}
              </span>
            )}
          </span>
        ) : value != null ? (
          <span className="text-slate-400 truncate">
            Project #{value}
          </span>
        ) : (
          <span className="text-slate-400">Select project…</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {value != null && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selected project"
              className="rounded p-0.5 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onChange(null);
                }
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
        </div>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-slate-400"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {listQuery.isLoading ? (
              <p className="px-3 py-2 text-[12px] text-slate-400 italic">Loading…</p>
            ) : projects.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-slate-400 italic">No projects found</p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    onChange(project.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-[13px] text-left hover:bg-slate-50',
                    project.id === value && 'bg-blue-50 text-blue-700',
                  )}
                >
                  <span className="truncate">{project.name}</span>
                  {project.number && (
                    <span className="ml-auto text-[11px] font-mono text-slate-400">
                      {project.number}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'ok' | 'warn' | 'info';
}) {
  const cfg = {
    neutral: 'text-slate-700 bg-slate-50 border-slate-200',
    ok: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    warn: 'text-amber-700 bg-amber-50 border-amber-200',
    info: 'text-blue-700 bg-blue-50 border-blue-200',
  }[tone];
  return (
    <div className={cn('rounded-lg border px-3 py-2', cfg)}>
      <div className="text-[11px] uppercase font-semibold tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-bold tabular-nums font-mono">{value}</div>
    </div>
  );
}

// ─── Preview row primitives (retained; used by PeopleTable) ──────────
// QA4 RD-1 superseded the standalone `PreviewTable` wrapper with
// `PeopleTable` (rendered inside each org card + the Individuals
// section). The row-level `PreviewTableRow` / `SecondaryContactRow`
// helpers stay — they still own the inline overrides + verdict UI.

function PreviewTh({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'text-left font-semibold px-2 py-2 border-b border-slate-200 dark:border-slate-700',
        className,
      )}
    >
      {children}
    </th>
  );
}

/** One data row + (optionally) an expanded detail row underneath. */
function PreviewTableRow({
  dec,
  row,
  rowDec,
  effectiveOrgAction,
  isExpanded,
  isFieldsExpanded,
  isSkipped,
  showCompany,
  onToggleExpand,
  onToggleFields,
  onToggleSkipped,
  onDecide,
  onOverride,
  onMovePerson,
  moveTargets,
  currentGroupKey,
  conflictResolutions,
  onConflictResolve,
}: {
  dec: DedupDecision;
  row: ResolvedRow;
  rowDec: RowDecision | undefined;
  effectiveOrgAction: DedupDecision['org']['action'];
  isExpanded: boolean;
  /**
   * QA4 E1 (2026-09-29) — separate expand state that opens a stacked
   * form of every editable field beneath the row. Independent of
   * `isExpanded` which still opens the dedup-reasoning info panel.
   */
  isFieldsExpanded: boolean;
  /** QA4 R2b ORG-6 — reviewer marked the row `skip` via the trash icon. */
  isSkipped: boolean;
  /**
   * QA4 RD-1 — nested people rows under an org card hide the Company
   * column (the card IS the parent identity); the Individuals section
   * keeps it so a stray company text is still visible.
   */
  showCompany: boolean;
  onToggleExpand: () => void;
  onToggleFields: () => void;
  onToggleSkipped: () => void;
  onDecide: (patch: Partial<RowDecision>) => void;
  onOverride: (field: OverrideField, value: string | null | undefined) => void;
  /** QA4 E4 (2026-09-29) — see PeopleTable props. */
  onMovePerson?: (rowIndex: number, targetKey: string | null) => void;
  moveTargets?: Array<{ key: string | null; label: string; domain?: string | null }>;
  currentGroupKey?: string | null;
  /** QA4 E5 (2026-09-29) — per-field conflict picks for matched people. */
  conflictResolutions?: Record<string, Record<string, 'existing' | 'imported'>>;
  onConflictResolve?: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
}) {
  const isConflict = dec.org.action === 'conflict';
  const belowContract = !dec.meetsMinimumContract;
  const hasWarning = !!(
    belowContract ||
    row.errors.length > 0 ||
    row.synthesis.emailSplitFailed ||
    row.synthesis.phoneSplitFailed
  );
  // ORG-6 takes the strongest visual precedence — struck-through +
  // muted background — so a removed row is unmistakable.
  const rowTint = isSkipped
    ? 'bg-slate-100/70 dark:bg-slate-800/50'
    : belowContract
      ? 'bg-red-50/40 dark:bg-red-950/20'
      : hasWarning
        ? 'bg-amber-50/30 dark:bg-amber-950/10'
        : '';
  // Muted content class applied on every td so the strikethrough
  // + opacity affect nested spans (line-through doesn't reliably
  // propagate through the tr).
  const rowMuted = isSkipped ? 'opacity-60 [&_span]:line-through [&_.font-mono]:no-underline' : '';
  // QA4 E4 (2026-09-29) — draggable handle for moving the person
  // between org cards. `data.rowIndex` gets carried into onDragEnd
  // so the container can call onMovePerson without another lookup.
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({
    id: `drag-person-${dec.sourceRowIndex}`,
    data: { type: 'person', rowIndex: dec.sourceRowIndex },
    disabled: !onMovePerson,
  });
  // QA4 IMP-2 — per-cell effective value: an override wins over the
  // parsed value; `null` means "PM cleared the cell"; `undefined` means
  // "no override, use parsed".
  const overrides = rowDec?.overrides ?? {};
  const effective = (field: OverrideField, parsed: string | null | undefined): string | null => {
    if (field in overrides) return overrides[field] ?? null;
    return parsed ?? null;
  };
  const isEdited = (field: OverrideField) => field in overrides;
  return (
    <>
      <tr className={cn('align-top', rowTint, rowMuted, isDragging && 'opacity-40')}>
        <td className="px-1 py-2 text-center whitespace-nowrap">
          <div className="inline-flex items-center gap-0.5">
            {/* QA4 E4 (2026-09-29) — drag handle. Kept small + subtle
                so it never competes with the chevron; hover reveals
                the cursor affordance. Only rendered when onMovePerson
                is available (individuals section + org cards). */}
            {onMovePerson && (
              <button
                type="button"
                ref={setDraggableRef}
                {...listeners}
                {...attributes}
                className="inline-flex items-center justify-center h-5 w-4 rounded text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-grab active:cursor-grabbing focus:outline-none focus:text-slate-500 dark:focus:text-slate-300"
                aria-label={`Drag row ${dec.sourceRowIndex} to another organization`}
                title="Drag to another organization"
              >
                <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {/* QA4 E1 (2026-09-29) — chevron toggles the stacked field
                editor beneath the row (all fields inline-editable). */}
            <button
              type="button"
              onClick={onToggleFields}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:bg-slate-100 dark:focus:bg-slate-800"
              aria-expanded={isFieldsExpanded}
              aria-label={isFieldsExpanded ? 'Collapse person fields' : 'Expand person fields'}
              title={isFieldsExpanded ? 'Hide all person fields' : 'Show all person fields'}
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 text-slate-500 dark:text-slate-400 transition-transform',
                  isFieldsExpanded && 'rotate-90',
                )}
                aria-hidden="true"
              />
            </button>
          </div>
        </td>
        <td className="px-2 py-2 border-r border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
          <div className="pt-0.5" title="Actual sheet row number — matches the source file">
            Row {dec.sourceRowIndex}
          </div>
        </td>
        <td className="px-2 py-2">
          <EditableCell
            field="discipline"
            value={effective('discipline', dec.values.discipline)}
            edited={isEdited('discipline')}
            inherited={!isEdited('discipline') && row.synthesis.disciplineFilled}
            onCommit={(v) => onOverride('discipline', v)}
          />
        </td>
        <td className="px-2 py-2">
          <EditableCell
            field="contact"
            value={effective('contact', dec.values.contact)}
            edited={isEdited('contact')}
            strong
            placeholder="no name"
            onCommit={(v) => onOverride('contact', v)}
          />
        </td>
        {showCompany && (
          <td className="px-2 py-2">
            <EditableCell
              field="company"
              value={effective('company', dec.values.company)}
              edited={isEdited('company')}
              inherited={!isEdited('company') && row.synthesis.companyFilled}
              placeholder="no company"
              onCommit={(v) => onOverride('company', v)}
            />
          </td>
        )}
        <td className="px-2 py-2">
          <EditableCell
            field="phone"
            value={effective('phone', dec.values.phone)}
            edited={isEdited('phone')}
            synthesized={!isEdited('phone') && row.synthesis.phoneSplit}
            failed={!isEdited('phone') && row.synthesis.phoneSplitFailed}
            onCommit={(v) => onOverride('phone', v)}
          />
        </td>
        <td className="px-2 py-2">
          <EditableCell
            field="mobile"
            value={effective('mobile', dec.values.mobile)}
            edited={isEdited('mobile')}
            synthesized={!isEdited('mobile') && row.synthesis.phoneSplit}
            onCommit={(v) => onOverride('mobile', v)}
          />
        </td>
        <td className="px-2 py-2">
          <EditableCell
            field="email"
            value={effective('email', dec.values.email)}
            edited={isEdited('email')}
            synthesized={!isEdited('email') && row.synthesis.emailSplit}
            failed={!isEdited('email') && row.synthesis.emailSplitFailed}
            onCommit={(v) => onOverride('email', v)}
          />
        </td>
        <td className="px-2 py-2">
          {/* QA4 RD-2 (2026-09-29) — per-person LINK / NEW badge. LINK
              when the commit would attach to an existing person BP
              (matched by email); NEW otherwise. `contact.matchedBpName`
              names the target row when known. */}
          {dec.contact.action === 'link' ? (
            <EntityBadge kind="link" matchedName={dec.contact.matchedBpName ?? null} />
          ) : dec.contact.action === 'create' ? (
            <EntityBadge kind="new" />
          ) : (
            <span className="text-[10px] italic text-slate-400 dark:text-slate-500">
              skip
            </span>
          )}
        </td>
        <td className="px-2 py-2">
          {/* IMP-6 (QA4 Round-2 · 2026-09-29): Job Title / Role cell.
              Always editable — even when the mapping didn't feed it, so
              the PM can add it during load. The commit prefers this
              override over `dec.values.role`. */}
          <EditableCell
            field="role"
            value={effective('role', dec.values.role)}
            edited={isEdited('role')}
            placeholder="—"
            onCommit={(v) => onOverride('role', v)}
          />
        </td>
        {/* QA4 IW-3 (2026-09-30) — Office manager column removed.
            Extracted office managers are rendered below as their own
            SecondaryContactRow (a normal person nested under the org).
            The `officeManager` OverrideField still exists for backward
            compat with any stale RowDecision payload but is no longer
            editable from the wizard. */}
        <td className="px-2 py-2">
          <VerdictCell
            dec={dec}
            effectiveOrgAction={effectiveOrgAction}
            isConflict={isConflict}
            hasWarning={hasWarning}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            onDecide={onDecide}
          />
        </td>
        {/* QA4 R2b ORG-6 — per-row trash / undo. */}
        <td className="px-2 py-2 text-center">
          {isSkipped ? (
            <button
              type="button"
              onClick={onToggleSkipped}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-500 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400"
              aria-label={`Restore row ${dec.sourceRowIndex}`}
              title="Restore this row to the import"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Undo
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleSkipped}
              className="inline-flex items-center justify-center h-6 w-6 rounded-md border border-transparent text-slate-400 dark:text-slate-500 hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400 focus:outline-none focus:border-red-500 dark:focus:border-red-500"
              aria-label={`Remove row ${dec.sourceRowIndex} from the import`}
              title="Remove this row from the import"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </td>
      </tr>
      {isFieldsExpanded && (
        <tr className={cn('align-top', rowTint)}>
          {/* QA4 E1 (2026-09-29) — expanded stacked field editor. Same
              colSpan math as the info panel: base 11 (chevron + row +
              Discipline + Contact + Phone + Mobile + Email + Person +
              Job Title + Verdict + trash) + 1 optional Company column.
              (QA4 IW-3 2026-09-30 — Office mgr column dropped, so the
              base count is 11 not 12.) Each field is an EditableCell
              so blur commits (mirrors the row's inline cells). */}
          <td colSpan={showCompany ? 12 : 11} className="px-3 pt-0 pb-3">
            <div className="rounded-md border border-blue-200 dark:border-blue-900/50 bg-blue-50/40 dark:bg-blue-950/20 p-3">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 mb-2">
                Row {dec.sourceRowIndex} · all fields
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2">
                <FieldEditorRow label="Name" hint="the person's display name (required)">
                  <EditableCell
                    field="contact"
                    value={(rowDec?.overrides && 'contact' in rowDec.overrides ? rowDec.overrides.contact ?? null : dec.values.contact ?? null)}
                    edited={!!rowDec?.overrides && 'contact' in (rowDec.overrides ?? {})}
                    strong
                    placeholder="no name"
                    onCommit={(v) => onOverride('contact', v)}
                  />
                </FieldEditorRow>
                {showCompany && (
                  <FieldEditorRow label="Company">
                    <EditableCell
                      field="company"
                      value={(rowDec?.overrides && 'company' in rowDec.overrides ? rowDec.overrides.company ?? null : dec.values.company ?? null)}
                      edited={!!rowDec?.overrides && 'company' in (rowDec.overrides ?? {})}
                      inherited={!(rowDec?.overrides && 'company' in rowDec.overrides) && row.synthesis.companyFilled}
                      placeholder="no company"
                      onCommit={(v) => onOverride('company', v)}
                    />
                  </FieldEditorRow>
                )}
                <FieldEditorRow label="Phone">
                  <EditableCell
                    field="phone"
                    value={(rowDec?.overrides && 'phone' in rowDec.overrides ? rowDec.overrides.phone ?? null : dec.values.phone ?? null)}
                    edited={!!rowDec?.overrides && 'phone' in (rowDec.overrides ?? {})}
                    synthesized={!(rowDec?.overrides && 'phone' in rowDec.overrides) && row.synthesis.phoneSplit}
                    failed={!(rowDec?.overrides && 'phone' in rowDec.overrides) && row.synthesis.phoneSplitFailed}
                    placeholder="—"
                    onCommit={(v) => onOverride('phone', v)}
                  />
                </FieldEditorRow>
                <FieldEditorRow label="Mobile">
                  <EditableCell
                    field="mobile"
                    value={(rowDec?.overrides && 'mobile' in rowDec.overrides ? rowDec.overrides.mobile ?? null : dec.values.mobile ?? null)}
                    edited={!!rowDec?.overrides && 'mobile' in (rowDec.overrides ?? {})}
                    synthesized={!(rowDec?.overrides && 'mobile' in rowDec.overrides) && row.synthesis.phoneSplit}
                    placeholder="—"
                    onCommit={(v) => onOverride('mobile', v)}
                  />
                </FieldEditorRow>
                <FieldEditorRow
                  label="Email"
                  hint={row.extraEmails && row.extraEmails.length > 0 ? `extras: ${row.extraEmails.join(', ')}` : undefined}
                >
                  <EditableCell
                    field="email"
                    value={(rowDec?.overrides && 'email' in rowDec.overrides ? rowDec.overrides.email ?? null : dec.values.email ?? null)}
                    edited={!!rowDec?.overrides && 'email' in (rowDec.overrides ?? {})}
                    synthesized={!(rowDec?.overrides && 'email' in rowDec.overrides) && row.synthesis.emailSplit}
                    failed={!(rowDec?.overrides && 'email' in rowDec.overrides) && row.synthesis.emailSplitFailed}
                    placeholder="—"
                    onCommit={(v) => onOverride('email', v)}
                  />
                </FieldEditorRow>
                <FieldEditorRow label="Discipline">
                  <EditableCell
                    field="discipline"
                    value={(rowDec?.overrides && 'discipline' in rowDec.overrides ? rowDec.overrides.discipline ?? null : dec.values.discipline ?? null)}
                    edited={!!rowDec?.overrides && 'discipline' in (rowDec.overrides ?? {})}
                    inherited={!(rowDec?.overrides && 'discipline' in rowDec.overrides) && row.synthesis.disciplineFilled}
                    placeholder="—"
                    onCommit={(v) => onOverride('discipline', v)}
                  />
                </FieldEditorRow>
                <FieldEditorRow label="Job title / role">
                  <EditableCell
                    field="role"
                    value={(rowDec?.overrides && 'role' in rowDec.overrides ? rowDec.overrides.role ?? null : dec.values.role ?? null)}
                    edited={!!rowDec?.overrides && 'role' in (rowDec.overrides ?? {})}
                    placeholder="—"
                    onCommit={(v) => onOverride('role', v)}
                  />
                </FieldEditorRow>
                {/* QA4 IW-3 (2026-09-30) — Office manager editor
                    dropped. Extracted managers now render as their
                    own nested SecondaryContactRow (a person under the
                    org) rather than a per-row summary field. */}
              </div>
              {/* QA4 E5 — per-field diff chooser for matched people. */}
              {dec.contact.action === 'link' && dec.contact.existingFields && onConflictResolve && (
                <div className="mt-3 pt-3 border-t border-blue-200 dark:border-blue-900/50 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    Conflicts with existing:
                  </span>
                  <ConflictResolver
                    recordKey={`person:${dec.sourceRowIndex}`}
                    existingFields={dec.contact.existingFields}
                    importedFields={{
                      contact: (rowDec?.overrides && 'contact' in rowDec.overrides ? rowDec.overrides.contact ?? null : dec.values.contact ?? null),
                      email: (rowDec?.overrides && 'email' in rowDec.overrides ? rowDec.overrides.email ?? null : dec.values.email ?? null),
                      phone: (rowDec?.overrides && 'phone' in rowDec.overrides ? rowDec.overrides.phone ?? null : dec.values.phone ?? null),
                      mobile: (rowDec?.overrides && 'mobile' in rowDec.overrides ? rowDec.overrides.mobile ?? null : dec.values.mobile ?? null),
                      discipline: (rowDec?.overrides && 'discipline' in rowDec.overrides ? rowDec.overrides.discipline ?? null : dec.values.discipline ?? null),
                      address: dec.values.address ?? null,
                      note: dec.values.note ?? null,
                    }}
                    picks={conflictResolutions?.[`person:${dec.sourceRowIndex}`] ?? {}}
                    onPick={onConflictResolve}
                    fieldOrder={[...PERSON_CONFLICT_FIELDS]}
                    fieldLabels={PERSON_CONFLICT_LABELS}
                  />
                </div>
              )}
              {onMovePerson && moveTargets && moveTargets.length > 0 && (
                <div className="mt-3 pt-3 border-t border-blue-200 dark:border-blue-900/50 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    Move to:
                  </span>
                  <MoveToDropdown
                    targets={moveTargets.filter((t) => t.key !== (currentGroupKey ?? null))}
                    onMove={(key) => onMovePerson(dec.sourceRowIndex, key)}
                  />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
      {isExpanded && (
        <tr className={cn('align-top', rowTint)}>
          {/* colSpan tracks the visible cells: base 11 (chevron +
              Sheet row + Discipline + Contact + Phone + Mobile +
              Email + Person badge + Job Title + Verdict + trash), plus
              1 for the optional Company column (RD-1: hidden under org
              cards, shown under Individuals). (QA4 IW-3 2026-09-30 —
              Office mgr column dropped, so base = 11.) */}
          <td colSpan={showCompany ? 12 : 11} className="px-3 pt-0 pb-2.5">
            <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-2 space-y-1">
              <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1">
                <span className="font-semibold">Organization:</span>{' '}
                <ActionBadge action={effectiveOrgAction} />
                <span className="text-slate-400 dark:text-slate-500 truncate">{dec.org.reason}</span>
                {dec.org.matchedBpName && (
                  <span className="text-slate-500 dark:text-slate-300">
                    → <strong>{dec.org.matchedBpName}</strong>
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1">
                <span className="font-semibold">Contact:</span>{' '}
                <ActionBadge action={dec.contact.action} />
                <span className="text-slate-400 dark:text-slate-500 truncate">
                  {dec.contact.reason}
                </span>
              </div>
              {dec.domain && (
                <div className="text-[11px] font-mono text-slate-600 dark:text-slate-300">
                  Domain:{' '}
                  <span
                    className={cn(
                      dec.isPersonalDomain
                        ? 'text-amber-600 dark:text-amber-300'
                        : 'text-emerald-600 dark:text-emerald-300',
                    )}
                  >
                    @{dec.domain}
                    {dec.isPersonalDomain && ' (personal)'}
                  </span>
                </div>
              )}
              {dec.contractError && (
                <div className="text-[11px] text-red-700 dark:text-red-300 flex items-center gap-1">
                  <XCircle className="h-3 w-3" /> {dec.contractError}
                </div>
              )}
              {row.errors.map((e, i) => (
                <div
                  key={i}
                  className="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1"
                >
                  <AlertTriangle className="h-3 w-3" /> {e}
                </div>
              ))}
              {row.extraPhones && row.extraPhones.length > 0 && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Extra phones: <span className="font-mono">{row.extraPhones.join(', ')}</span>
                </div>
              )}
              {row.extraEmails && row.extraEmails.length > 0 && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Extra emails: <span className="font-mono">{row.extraEmails.join(', ')}</span>
                </div>
              )}
              {(rowDec?.orgBpId != null || rowDec?.contactBpId != null) && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Linking to{' '}
                  {rowDec?.orgBpId != null && <>org BP #{rowDec.orgBpId} </>}
                  {rowDec?.contactBpId != null && <>· person BP #{rowDec.contactBpId}</>}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One cell in the preview table. Renders the value plus inline markers
 * (inherited from forward-fill, synthesized from a split, failed split,
 * extracted from a mixed cell). Placeholder shown when the value is
 * blank. `strong` bolds the value (used for the primary contact name).
 */
/**
 * QA4 IMP-4 — one extracted-secondary row. Rendered immediately under
 * the primary row it was extracted from so the parent-child structure
 * is obvious. Every cell that carries an extracted value shows the
 * "extracted" tag. Fields inherit the primary row's discipline +
 * company (mirroring the classifier's assembly rule). Not editable
 * inline yet — the primary row's Office manager column is editable
 * and is where the PM adjusts extractions today.
 */
function SecondaryContactRow({
  primary,
  secondary,
  showCompany,
}: {
  primary: DedupDecision;
  secondary: SecondaryContact;
  /** QA4 RD-1 — match the primary row's column layout under org cards. */
  showCompany: boolean;
}) {
  return (
    <tr className="align-top bg-indigo-50/30 dark:bg-indigo-950/10">
      <td className="px-2 py-2" aria-hidden="true">&nbsp;</td>
      <td className="px-2 py-2 border-r border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
        <div className="pt-0.5">
          <span className="text-indigo-500 dark:text-indigo-400 mr-1">↳</span>
          Row {primary.sourceRowIndex}
        </div>
      </td>
      <td className="px-2 py-2">
        <PreviewCell value={primary.values.discipline || null} inherited />
      </td>
      <td className="px-2 py-2">
        <PreviewCell value={secondary.name} extracted strong />
      </td>
      {showCompany && (
        <td className="px-2 py-2">
          <PreviewCell value={primary.values.company || null} inherited />
        </td>
      )}
      <td className="px-2 py-2">
        <PreviewCell value={secondary.phone ?? null} extracted={!!secondary.phone} />
      </td>
      <td className="px-2 py-2">
        <PreviewCell value={secondary.mobile ?? null} extracted={!!secondary.mobile} />
      </td>
      <td className="px-2 py-2">
        <PreviewCell value={secondary.email ?? null} extracted={!!secondary.email} />
      </td>
      <td className="px-2 py-2">
        {/* QA4 RD-2 — secondary contacts always create; keep them
            visually aligned with the primary row's Person column. */}
        <EntityBadge kind="new" />
      </td>
      {/* QA4 IW-3 (2026-09-30) — the standalone Office manager column
          is gone; the secondary's title (usually "Office manager")
          now lives in the Job Title column so it reads as a normal
          person's role. */}
      <td className="px-2 py-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span
            className="truncate text-slate-700 dark:text-slate-200 font-semibold"
            title={
              secondary.city
                ? `${secondary.title} · ${secondary.city}`
                : `${secondary.title} (extracted from ${secondary.sourceField} cell)`
            }
          >
            {secondary.title}
          </span>
          <span className="flex items-center gap-1 flex-wrap">
            <CellTag tone="extracted">extracted</CellTag>
            {secondary.city && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                {secondary.city}
              </span>
            )}
          </span>
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-col gap-1">
          <ActionBadge action="create" />
          <span
            className="text-[10px] text-slate-400 dark:text-slate-500 italic"
            title={`Classifier confidence ${(secondary.confidence * 100).toFixed(0)}% · sourceField ${secondary.sourceField}`}
          >
            secondary
          </span>
        </div>
      </td>
      {/* Empty trash column keeps the row width aligned with the
          primary rows above (ORG-6). Secondary contacts follow the
          primary's skip state — removing the primary drops them too. */}
      <td className="px-2 py-2" />
    </tr>
  );
}

function PreviewCell({
  value,
  inherited,
  synthesized,
  failed,
  extracted,
  strong,
  placeholder,
}: {
  value: string | null;
  inherited?: boolean;
  synthesized?: boolean;
  failed?: boolean;
  extracted?: boolean;
  strong?: boolean;
  placeholder?: string;
}) {
  if (!value) {
    return (
      <span className="italic text-slate-400 dark:text-slate-500">{placeholder ?? '—'}</span>
    );
  }
  const title = inherited
    ? 'Inherited from a row above (forward-fill)'
    : synthesized
      ? 'Split from a multi-value cell'
      : failed
        ? 'Split failed — cell has a delimiter but a piece is invalid'
        : extracted
          ? 'Extracted by the content classifier'
          : undefined;
  return (
    <div className="min-w-0 flex flex-col gap-0.5">
      <span
        className={cn(
          'truncate',
          strong ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200',
        )}
        title={title}
      >
        {value}
      </span>
      {(inherited || synthesized || failed || extracted) && (
        <span className="flex items-center gap-1 flex-wrap">
          {inherited && <CellTag tone="inherited">inherited</CellTag>}
          {synthesized && !failed && <CellTag tone="split">split</CellTag>}
          {failed && <CellTag tone="failed">split failed</CellTag>}
          {extracted && <CellTag tone="extracted">extracted</CellTag>}
        </span>
      )}
    </div>
  );
}

/**
 * QA4 IMP-2 — inline-editable version of PreviewCell. Click switches
 * to an `<input>`; Enter or blur commits; ESC cancels. `edited` shows
 * a small marker so it is obvious which cells the PM changed before
 * committing. Overrides live on the row's decision (extends the wizard
 * `decisions` model keyed by `${sheet}::${rowIndex}` — see the
 * `onOverride` handler in the wizard body).
 *
 * Empty string commits are normalised to `null` (semantically "clear
 * this parsed value"). Passing `undefined` back to onCommit isn't
 * exposed on this control; the PM re-enters and clears the cell to
 * remove the value.
 */
function EditableCell({
  field: _field,
  value,
  edited,
  inherited,
  synthesized,
  failed,
  extracted,
  strong,
  placeholder,
  onCommit,
}: {
  field: OverrideField;
  value: string | null;
  edited?: boolean;
  inherited?: boolean;
  synthesized?: boolean;
  failed?: boolean;
  extracted?: boolean;
  strong?: boolean;
  placeholder?: string;
  onCommit: (value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? '');
      // Focus + place caret at the end so quick single-char edits feel natural.
      queueMicrotask(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      });
    }
  }, [editing, value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    const next: string | null = trimmed === '' ? null : trimmed;
    // Only fire when the value actually changed vs. what we currently render.
    if ((value ?? '') !== (next ?? '')) onCommit(next);
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className={cn(
          'w-full px-1.5 py-1 rounded-md border text-[12px]',
          'border-blue-400 dark:border-blue-500 bg-white dark:bg-slate-900',
          'text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
        )}
        aria-label="Edit cell value"
      />
    );
  }

  // Read mode — a button so the whole cell is keyboard-reachable + click-to-edit.
  const hasValue = !!value;
  const title = edited
    ? 'Edited — this value overrides the parsed one on commit. Click to change.'
    : inherited
      ? 'Inherited from a row above (forward-fill). Click to override.'
      : synthesized
        ? 'Split from a multi-value cell. Click to override.'
        : failed
          ? 'Split failed — cell has a delimiter but a piece is invalid. Click to fix.'
          : extracted
            ? 'Extracted by the content classifier. Click to override.'
            : 'Click to edit';
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={title}
      className={cn(
        'group w-full min-w-0 text-left rounded px-1 py-0.5 -mx-1 -my-0.5',
        'hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none',
        'focus:bg-slate-100 dark:focus:bg-slate-800',
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        {hasValue ? (
          <span
            className={cn(
              'truncate block',
              strong
                ? 'font-semibold text-slate-800 dark:text-slate-100'
                : 'text-slate-700 dark:text-slate-200',
              edited && 'text-emerald-800 dark:text-emerald-200',
            )}
          >
            {value}
          </span>
        ) : (
          <span className="italic text-slate-400 dark:text-slate-500">
            {placeholder ?? '—'}
          </span>
        )}
        {(edited || inherited || synthesized || failed || extracted) && (
          <span className="flex items-center gap-1 flex-wrap">
            {edited && <CellTag tone="edited">edited</CellTag>}
            {inherited && !edited && <CellTag tone="inherited">inherited</CellTag>}
            {synthesized && !failed && !edited && <CellTag tone="split">split</CellTag>}
            {failed && !edited && <CellTag tone="failed">split failed</CellTag>}
            {extracted && !edited && <CellTag tone="extracted">extracted</CellTag>}
          </span>
        )}
      </div>
    </button>
  );
}

function CellTag({
  tone,
  children,
}: {
  tone: 'inherited' | 'split' | 'failed' | 'extracted' | 'edited';
  children: React.ReactNode;
}) {
  const cfg = {
    inherited:
      'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
    split:
      'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
    failed:
      'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900',
    extracted:
      'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-900',
    edited:
      'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[4px] border px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide',
        cfg,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Verdict column — the small chip + (for conflicts) the resolver
 * dropdown + (when warnings exist) the "!" toggle for the detail row.
 */
function VerdictCell({
  dec,
  effectiveOrgAction,
  isConflict,
  hasWarning,
  isExpanded,
  onToggleExpand,
  onDecide,
}: {
  dec: DedupDecision;
  effectiveOrgAction: DedupDecision['org']['action'];
  isConflict: boolean;
  hasWarning: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1">
        <ActionBadge action={effectiveOrgAction} />
        <button
          type="button"
          onClick={onToggleExpand}
          className={cn(
            'ml-auto inline-flex items-center justify-center h-5 w-5 rounded border text-[10px] font-bold transition-colors focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
            hasWarning
              ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40'
              : 'border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800',
          )}
          title={
            isExpanded
              ? 'Hide row details'
              : hasWarning
                ? 'Show warnings + dedup reasoning'
                : 'Show dedup reasoning'
          }
          aria-expanded={isExpanded}
        >
          {hasWarning ? '!' : 'i'}
        </button>
      </div>
      {isConflict ? (
        <select
          value={effectiveOrgAction}
          onChange={(e) => onDecide({ orgAction: e.target.value as 'link' | 'create' | 'skip' })}
          className="w-full px-1.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] text-slate-700 dark:text-slate-200 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none"
        >
          <option value="conflict">— pick —</option>
          <option value="skip">Skip row</option>
          <option value="create">Create new org</option>
          {dec.org.matchedBpId && <option value="link">Link to matched organization</option>}
        </select>
      ) : (
        <span className="text-[10px] text-slate-300 dark:text-slate-600 italic">auto</span>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const cfg = {
    create:
      'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
    link: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300',
    conflict:
      'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
    skip: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  }[action] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400';
  return (
    <span
      className={cn('font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-[5px]', cfg)}
    >
      {action}
    </span>
  );
}

// ─── Step 5: Commit summary ──────────────────────────────────────────
function CommitStep({
  result,
  attachToProjectId,
  onAnother,
  onDone,
}: {
  result: Awaited<ReturnType<typeof contactsImportApi.commit>>;
  attachToProjectId: number | null;
  onAnother: () => void;
  onDone?: () => void;
}) {
  const ok = result.errors === 0;
  // Fetch the target project so we can name it in the summary — makes
  // "24 people attached to Acme HQ" scan-in-one-glance vs. "24 attached
  // to a project" (which the top banner also carries as a fallback).
  const projectQuery = useProject(attachToProjectId ?? 0);
  const projectName =
    attachToProjectId != null && projectQuery.data?.id === attachToProjectId
      ? projectQuery.data.name
      : null;
  const projectRequested = attachToProjectId != null;
  const attachedNone = projectRequested && result.projectAttached === 0;
  return (
    <div className="space-y-4">
      <div
        className={cn(
          'rounded-[14px] border p-5 flex items-center gap-3',
          ok ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50',
        )}
      >
        {ok ? (
          <CheckCircle2 className="h-8 w-8 text-emerald-600 shrink-0" />
        ) : (
          <AlertTriangle className="h-8 w-8 text-amber-600 shrink-0" />
        )}
        <div>
          <div className={cn('text-base font-bold', ok ? 'text-emerald-900' : 'text-amber-900')}>
            {ok ? 'Import complete' : 'Import finished with errors'}
          </div>
          <div className={cn('text-[13px] mt-0.5', ok ? 'text-emerald-800' : 'text-amber-800')}>
            {result.orgsCreated + result.orgsLinked} orgs ·{' '}
            {result.contactsCreated + result.contactsLinked} contacts ·{' '}
            {result.workerOfLinksCreated} employer links
            {result.projectAttached > 0 &&
              ` · ${result.projectAttached} attached to ${projectName ?? 'the project'}`}
            {result.errors > 0 && ` · ${result.errors} errors`}
          </div>
        </div>
      </div>

      {attachedNone && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start gap-2 text-[12px] text-amber-800">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>0 people attached to {projectName ?? 'the project'}.</strong> Every row either
            skipped (missing email or phone, or user-marked "skip") or no role type was resolvable — pick
            a role explicitly on the Preview step, or ensure the <code>contact</code>{' '}
            / <code>external_contact</code> project-role type is seeded.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Orgs created" value={result.orgsCreated} tone="ok" />
        <SummaryTile label="Orgs linked" value={result.orgsLinked} tone="info" />
        <SummaryTile label="Contacts created" value={result.contactsCreated} tone="ok" />
        <SummaryTile label="Contacts linked" value={result.contactsLinked} tone="info" />
        <SummaryTile label="Employer links" value={result.workerOfLinksCreated} tone="info" />
        {projectRequested && (
          <SummaryTile
            label={projectName ? `Attached · ${projectName}` : 'Attached to project'}
            value={result.projectAttached}
            tone={result.projectAttached > 0 ? 'ok' : 'warn'}
          />
        )}
        <SummaryTile label="Missing email or phone" value={result.belowContract} tone="warn" />
        <SummaryTile label="Skipped" value={result.orgsSkipped + result.contactsSkipped} />
        <SummaryTile label="Errors" value={result.errors} tone={result.errors ? 'warn' : 'neutral'} />
      </div>

      {result.perRow.some((r) => r.status === 'error') && (
        <div className="rounded-[14px] border border-red-200 dark:border-red-900/50 bg-white dark:bg-slate-900 divide-y divide-red-100 dark:divide-red-900/50 max-h-64 overflow-y-auto">
          <div className="bg-[#FAFBFC] dark:bg-slate-800/70 px-3 py-1.5 text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">
            Errors
          </div>
          {result.perRow
            .filter((r) => r.status === 'error')
            .map((r) => (
              <div key={r.sourceRowIndex} className="px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
                <span className="font-mono text-[11px]">Row {r.sourceRowIndex}</span> · {r.message}
              </div>
            ))}
        </div>
      )}

      {/* QA4 IW-BUG (2026-09-30) — belt-and-suspenders orphan guard.
          Any row that reached the commit path with `create person` +
          no resolved org gets withheld and surfaces here. In practice
          the E6 FE gate blocks these before commit; this section
          exists so a slipped-through case is IMPOSSIBLE to miss. */}
      {(result.withheldOrphans?.length ?? 0) > 0 && (
        <div className="rounded-[14px] border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 max-h-64 overflow-y-auto">
          <div className="bg-amber-100/70 dark:bg-amber-900/40 px-3 py-1.5 text-[11px] uppercase font-semibold text-amber-800 dark:text-amber-200 tracking-[0.05em] flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Withheld orphans ({result.withheldOrphans!.length})
          </div>
          <div className="divide-y divide-amber-200 dark:divide-amber-900/50">
            {result.withheldOrphans!.map((o) => (
              <div key={o.sourceRowIndex} className="px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                <span className="font-mono text-[11px]">Row {o.sourceRowIndex}</span> ·{' '}
                <span className="font-semibold">{o.personKey}</span> — {o.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={onAnother}
          className="rounded-lg border border-slate-200 hover:border-slate-400 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700"
        >
          Import another file
        </button>
        {onDone && (
          <button
            onClick={onDone}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Stage 2 hands us a `mapping` keyed by column INDEX. The wizard body
 * carries the mapping keyed by HEADER TEXT (matches presets + Stage 5's
 * server contract). Translate.
 */
function indexMappingToHeaderMapping(
  indexMapping: Partial<Record<ContactField, number>>,
  headerCells: string[],
): ContactsMapping {
  const out: ContactsMapping = {};
  for (const [field, idx] of Object.entries(indexMapping)) {
    if (idx == null) continue;
    const cell = headerCells[idx];
    if (cell) out[field as ContactField] = cell;
  }
  return out;
}

/**
 * Two mappings are equivalent when every field maps to the same header
 * (treating "unset" and "empty string" as identical). Used to decide
 * whether a Map-step edit invalidates decisions already taken on
 * Preview. People UX U4 (P-20) · 2026-09-27
 *
 * QA4 R2 IMP-8 (2026-09-29) — a field value can now be an ordered list
 * of source headers; equality is set-based on the list contents so
 * re-ordering doesn't spuriously invalidate decisions.
 */
function mappingsEqual(a: ContactsMapping, b: ContactsMapping): boolean {
  const fields = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const f of fields) {
    const av = mapHeaderList(a[f as ContactField]);
    const bv = mapHeaderList(b[f as ContactField]);
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

/**
 * QA4 R2 IMP-8 — normalise a mapping field value to an ordered list of
 * header strings, dropping empties + duplicates. Mirrors the backend
 * `mappingHeaders` helper so the FE and BE agree on shape.
 */
function mapHeaderList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of arr) {
    const t = (h ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * QA4 R2 IMP-8 — replace the header at `index`, then collapse the list
 * back to a scalar / undefined / array so the mapping stays in its
 * canonical shape (single header = string, none = undefined).
 */
function setMappingHeaderAt(
  headers: string[],
  index: number,
  value: string,
): string | string[] | undefined {
  const next = headers.slice();
  if (index >= next.length) next.push(value);
  else next[index] = value;
  return normaliseMappingList(next);
}

function removeMappingHeaderAt(
  headers: string[],
  index: number,
): string | string[] | undefined {
  const next = headers.slice();
  next.splice(index, 1);
  return normaliseMappingList(next);
}

function normaliseMappingList(list: string[]): string | string[] | undefined {
  const cleaned = mapHeaderList(list);
  if (cleaned.length === 0) return undefined;
  if (cleaned.length === 1) return cleaned[0];
  return cleaned;
}

/**
 * QA4 RD-3 (2026-09-29) — mirror of the backend's `isPlausibleCompanyName`.
 * A raw company cell is displayed as an org label only when it looks
 * like a real firm identity: not empty, not a bare `-` / `—`, not a
 * single character, and not an email. Kept in sync with the BE version
 * so the wizard preview + the commit path agree on what "unnamed org"
 * looks like.
 */
function isPlausibleCompanyDisplay(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim();
  if (!s || s.length < 2) return false;
  if (s.includes('@')) return false;
  if (/^[-‐-―–—]+$/.test(s)) return false;
  return true;
}

/**
 * QA4 E5 (2026-09-29) — per-field conflict chooser. Given the imported
 * row's effective values and the matched BP's existingFields, renders
 * one line per differing field with a small toggle between "keep
 * existing" and "use imported". Nothing renders when there are no
 * differences.
 */
function ConflictResolver({
  recordKey,
  existingFields,
  importedFields,
  picks,
  onPick,
  fieldOrder,
  fieldLabels,
}: {
  recordKey: string;
  existingFields: Partial<Record<string, string | null>>;
  importedFields: Partial<Record<string, string | null>>;
  picks: Record<string, 'existing' | 'imported'>;
  onPick: (recordKey: string, field: string, choice: 'existing' | 'imported') => void;
  fieldOrder: string[];
  fieldLabels: Record<string, string>;
}) {
  const diffs = useMemo(() => {
    const out: Array<{ field: string; existing: string | null; imported: string | null }> = [];
    for (const field of fieldOrder) {
      const existing = existingFields[field] ?? null;
      const imported = importedFields[field] ?? null;
      const e = (existing ?? '').trim();
      const i = (imported ?? '').trim();
      if (e === i) continue;
      out.push({ field, existing, imported });
    }
    return out;
  }, [fieldOrder, existingFields, importedFields]);
  const [open, setOpen] = useState(false);
  if (diffs.length === 0) return null;
  const undecided = diffs.filter((d) => !picks[d.field]).length;
  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide focus:outline-none',
          undecided > 0
            ? 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 focus:border-amber-600'
            : 'border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 focus:border-blue-500',
        )}
        title={
          undecided > 0
            ? `${undecided} field${undecided === 1 ? '' : 's'} differ from existing — click to review`
            : `${diffs.length} conflict${diffs.length === 1 ? '' : 's'} resolved`
        }
      >
        {diffs.length} {diffs.length === 1 ? 'diff' : 'diffs'}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-2 max-w-xl">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="text-left font-semibold px-1 py-1 w-20">Field</th>
                <th className="text-left font-semibold px-1 py-1">Existing</th>
                <th className="text-left font-semibold px-1 py-1">Imported</th>
                <th className="text-left font-semibold px-1 py-1 w-32">Keep</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {diffs.map((d) => {
                const choice = picks[d.field] ?? 'existing';
                return (
                  <tr key={d.field} className="align-top">
                    <td className="px-1 py-1 font-semibold text-slate-600 dark:text-slate-300">
                      {fieldLabels[d.field] ?? d.field}
                    </td>
                    <td className="px-1 py-1">
                      <span
                        className={cn(
                          'inline-block max-w-[10rem] truncate rounded px-1 py-0.5',
                          choice === 'existing' && 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 font-semibold',
                        )}
                        title={d.existing ?? '(empty)'}
                      >
                        {d.existing ?? <span className="italic text-slate-400">empty</span>}
                      </span>
                    </td>
                    <td className="px-1 py-1">
                      <span
                        className={cn(
                          'inline-block max-w-[10rem] truncate rounded px-1 py-0.5',
                          choice === 'imported' && 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 font-semibold',
                        )}
                        title={d.imported ?? '(empty)'}
                      >
                        {d.imported ?? <span className="italic text-slate-400">empty</span>}
                      </span>
                    </td>
                    <td className="px-1 py-1">
                      <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-[10px] font-semibold">
                        <button
                          type="button"
                          onClick={() => onPick(recordKey, d.field, 'existing')}
                          className={cn(
                            'px-1.5 py-0.5',
                            choice === 'existing'
                              ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200'
                              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                          )}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => onPick(recordKey, d.field, 'imported')}
                          className={cn(
                            'px-1.5 py-0.5 border-l border-slate-200 dark:border-slate-700',
                            choice === 'imported'
                              ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200'
                              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                          )}
                        >
                          Use
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ORG_CONFLICT_FIELDS = ['company', 'email', 'phone', 'mobile', 'address', 'note'] as const;
const ORG_CONFLICT_LABELS: Record<string, string> = {
  company: 'Name',
  email: 'Email',
  phone: 'Phone',
  mobile: 'Mobile',
  address: 'Address',
  note: 'Notes',
};
const PERSON_CONFLICT_FIELDS = ['contact', 'email', 'phone', 'mobile', 'discipline', 'address', 'note'] as const;
const PERSON_CONFLICT_LABELS: Record<string, string> = {
  contact: 'Name',
  email: 'Email',
  phone: 'Phone',
  mobile: 'Mobile',
  discipline: 'Discipline',
  address: 'Address',
  note: 'Notes',
};

/**
 * QA4 E1 (2026-09-29) — one label + editable cell in the stacked
 * "all fields" panel that expands beneath a person row. The child is
 * an EditableCell already wired to the row's `onOverride`.
 */
function FieldEditorRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-baseline gap-1">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">
          {label}
        </span>
        {hint && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500 italic truncate">
            {hint}
          </span>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * QA4 E4 (2026-09-29) — "Move to…" dropdown fallback for the drag-and-
 * drop person mover. Lists every other org card + a "Move to
 * Individuals" entry. Keyboard-accessible; type-to-filter.
 */
function MoveToDropdown({
  targets,
  onMove,
}: {
  targets: Array<{ key: string | null; label: string; domain?: string | null }>;
  onMove: (targetKey: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? targets.filter(
        (t) => t.label.toLowerCase().includes(needle) || (t.domain ?? '').toLowerCase().includes(needle),
      )
    : targets;
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 focus:outline-none focus:border-blue-500 dark:focus:border-blue-400"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        Choose org <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg overflow-hidden">
          <div className="border-b border-slate-100 dark:border-slate-800 px-2 py-1.5">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent text-[12px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] italic text-slate-400 dark:text-slate-500">
                No matches
              </div>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.key ?? '__ind__'}
                  type="button"
                  onClick={() => {
                    onMove(t.key);
                    setOpen(false);
                    setQ('');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
                >
                  <span className="truncate">{t.label}</span>
                  {t.domain && (
                    <span className="ml-auto text-[10px] font-mono text-slate-400 dark:text-slate-500">
                      @{t.domain}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
