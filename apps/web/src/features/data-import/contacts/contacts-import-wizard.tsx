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
import { useEffect, useMemo, useRef, useState } from 'react';
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
  X,
} from 'lucide-react';

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
  ResolvedRow,
  RowDecision,
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
 * Backend fallback order — mirror the resolver in `commit.service.ts`
 * `pickProjectRoleId()` so the dropdown's default matches what the
 * server would pick if we sent `projectRoleId: null`.
 */
const FALLBACK_ROLE_CODES = ['contact', 'external_contact', 'consultant'] as const;

type WizardStep = 'upload' | 'sheet' | 'map' | 'preview' | 'commit';

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

  // ─── Stepper ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <Stepper step={step} />

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
function Stepper({ step }: { step: WizardStep }) {
  const steps: WizardStep[] = ['upload', 'sheet', 'map', 'preview', 'commit'];
  const idx = steps.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
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
                !done && !active && 'bg-slate-200 text-slate-500',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={cn(active ? 'text-slate-900 font-semibold' : 'text-slate-500')}>
              {STEP_LABELS[s]}
            </span>
            {i < steps.length - 1 && <span className="text-slate-300">›</span>}
          </li>
        );
      })}
    </ol>
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
          className="flex items-center gap-1 text-[13px] font-semibold text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Cancel
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
  const applicablePresets = useMemo(() => {
    const set = new Set(headerCells.filter(Boolean));
    return presets.filter((p) =>
      Object.values(p.mapping).every((h) => !h || set.has(h)),
    );
  }, [presets, headerCells]);

  const canProceed = !!(mapping.email || mapping.phone || mapping.mobile);

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
          // People UX M5 — wire label to select with a real htmlFor/id
          // pair so screen readers announce the field name when the
          // select gets focus (was a floating <label> pointing nowhere).
          const selectId = `contacts-map-${field}`;
          return (
            <div key={field} className="grid grid-cols-[180px_1fr] items-center gap-4 px-4 py-3">
              <div>
                <label htmlFor={selectId} className="text-[13px] font-semibold text-slate-700">
                  {CONTACT_FIELD_LABELS[field]}
                </label>
              </div>
              <select
                id={selectId}
                value={mapping[field] ?? ''}
                onChange={(e) => onChange({ ...mapping, [field]: e.target.value || undefined })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="">— skip —</option>
                {headerCells.filter(Boolean).map((h, i) => (
                  <option key={`${h}-${i}`} value={h}>
                    {h}
                  </option>
                ))}
              </select>
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
  onDecide,
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
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Total rows" value={s.totalRows} />
        <SummaryTile label="Eligible" value={s.eligible} tone="ok" />
        <SummaryTile label="Missing email or phone" value={s.belowContract} tone={s.belowContract > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Conflicts" value={s.orgConflicts} tone={s.orgConflicts > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Orgs · create" value={s.orgsToCreate} tone="ok" />
        <SummaryTile label="Orgs · link" value={s.orgsToLink} tone="info" />
        <SummaryTile label="Contacts · create" value={s.contactsToCreate} tone="ok" />
        <SummaryTile label="Contacts · link" value={s.contactsToLink} tone="info" />
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

      <PreviewTable
        visibleDecisions={visibleDecisions}
        rowByIndex={rowByIndex}
        decisions={decisions}
        decisionKeyFor={decisionKeyFor}
        conflictsOnly={conflictsOnly}
        onDecide={onDecide}
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
          disabled={isBusy || s.eligible === 0 || unresolvedConflicts > 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50 focus:outline-none focus:border-blue-400"
        >
          {isBusy
            ? 'Committing…'
            : unresolvedConflicts > 0
              ? `Resolve ${unresolvedConflicts} conflict${unresolvedConflicts === 1 ? '' : 's'} to continue`
              : `Commit ${s.eligible} rows`}{' '}
          {unresolvedConflicts === 0 && <ArrowRight className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
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
  onProjectRoleChange,
  roleTypes,
  roleTypesLoading,
}: {
  attachToProjectId: number | null;
  onAttachProjectChange: (id: number | null) => void;
  projectRoleId: number | null;
  onProjectRoleChange: (id: number | null) => void;
  roleTypes: ProjectRoleTypeLite[];
  roleTypesLoading: boolean;
}) {
  const roleEnabled = attachToProjectId != null;
  const fallbackDefault = useMemo(() => {
    for (const code of FALLBACK_ROLE_CODES) {
      const found = roleTypes.find((rt) => rt.code === code);
      if (found) return found;
    }
    return null;
  }, [roleTypes]);

  return (
    <div className="rounded-[14px] border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FolderKanban className="h-4 w-4 text-indigo-500" />
        <h3 className="text-[13px] font-semibold text-slate-700">
          Attach to project <span className="font-normal text-slate-400">(optional)</span>
        </h3>
      </div>
      <p className="text-[11px] text-slate-500">
        Pick a project to add every committed person to its team. Each row's
        <span className="font-mono px-1 text-slate-600">discipline</span> column becomes the
        person's <em>title on project</em>; the role-type here is the participation role. Leave
        both empty for a global import (creates contacts and links them to their organizations only).
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1 block">
            Project
          </label>
          <ProjectPickerInline
            value={attachToProjectId}
            onChange={onAttachProjectChange}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1 block">
            Role on project
          </label>
          <select
            value={projectRoleId ?? ''}
            onChange={(e) =>
              onProjectRoleChange(e.target.value ? Number(e.target.value) : null)
            }
            disabled={!roleEnabled || roleTypesLoading}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-700 bg-white focus:border-blue-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
          >
            <option value="">
              {roleTypesLoading
                ? 'Loading roles…'
                : fallbackDefault
                  ? `— default: ${fallbackDefault.name} —`
                  : '— no role · project attach will be skipped —'}
            </option>
            {roleTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name}
                {rt.code === fallbackDefault?.code ? ' · default' : ''}
              </option>
            ))}
          </select>
          {!roleEnabled && (
            <p className="mt-1 text-[11px] text-slate-400">Pick a project first.</p>
          )}
          {roleEnabled && projectRoleId == null && !fallbackDefault && (
            <p className="mt-1 text-[11px] text-amber-600">
              No fallback role-type seeded — pick one, or people will not be attached.
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

// ─── Preview table (QA4 IMP-1) ───────────────────────────────────────
/**
 * Tabular replacement for the old row-by-row card list. One column per
 * parsed field so every value is scannable at a glance; inherited /
 * split / extracted markers render inline on the cell that carries them
 * (matching the Design Principle in `docs/bm2/qa4-import-preview.md`).
 *
 * Warnings / contract errors collapse into an expandable detail row
 * revealed by the "!" icon in the Verdict column. Reuses the shared
 * design-system tokens; hand-rolled `<table>` (not DataTable) because
 * the cells have custom behaviour: inline overrides (IMP-2 wires in),
 * bespoke verdict chips, secondary-contact rows (IMP-4).
 */
function PreviewTable({
  visibleDecisions,
  rowByIndex,
  decisions,
  decisionKeyFor,
  conflictsOnly,
  onDecide,
}: {
  visibleDecisions: DedupDecision[];
  rowByIndex: Map<number, ResolvedRow>;
  decisions: Record<string, RowDecision>;
  decisionKeyFor: (rowIndex: number) => string;
  conflictsOnly: boolean;
  onDecide: (rowIndex: number, patch: Partial<RowDecision>) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 px-3 py-1.5 text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]">
        Row-by-row preview{conflictsOnly && ' — conflicts only'}
      </div>
      <div className="max-h-[520px] overflow-auto">
        {visibleDecisions.length === 0 ? (
          <div className="px-3 py-10 text-center text-[12px] text-slate-400 dark:text-slate-500">
            No rows match this filter.
          </div>
        ) : (
          <table className="w-full text-[12px] border-collapse">
            <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800/70 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <tr>
                <PreviewTh className="w-16">Sheet row</PreviewTh>
                <PreviewTh>Discipline</PreviewTh>
                <PreviewTh>Contact</PreviewTh>
                <PreviewTh>Company</PreviewTh>
                <PreviewTh>Phone</PreviewTh>
                <PreviewTh>Mobile</PreviewTh>
                <PreviewTh>Email</PreviewTh>
                <PreviewTh>Office manager</PreviewTh>
                <PreviewTh className="w-40">Verdict</PreviewTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleDecisions.map((d) => {
                const row = rowByIndex.get(d.sourceRowIndex);
                if (!row) return null;
                const rowDec = decisions[decisionKeyFor(d.sourceRowIndex)];
                const effectiveOrgAction = rowDec?.orgAction ?? d.org.action;
                const isExpanded = expanded.has(d.sourceRowIndex);
                return (
                  <PreviewTableRow
                    key={d.sourceRowIndex}
                    dec={d}
                    row={row}
                    rowDec={rowDec}
                    effectiveOrgAction={effectiveOrgAction}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggle(d.sourceRowIndex)}
                    onDecide={(patch) => onDecide(d.sourceRowIndex, patch)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

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
  onToggleExpand,
  onDecide,
}: {
  dec: DedupDecision;
  row: ResolvedRow;
  rowDec: RowDecision | undefined;
  effectiveOrgAction: DedupDecision['org']['action'];
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  const isConflict = dec.org.action === 'conflict';
  const belowContract = !dec.meetsMinimumContract;
  const hasWarning = !!(
    belowContract ||
    row.errors.length > 0 ||
    row.synthesis.emailSplitFailed ||
    row.synthesis.phoneSplitFailed
  );
  const rowTint = belowContract
    ? 'bg-red-50/40 dark:bg-red-950/20'
    : hasWarning
      ? 'bg-amber-50/30 dark:bg-amber-950/10'
      : '';
  return (
    <>
      <tr className={cn('align-top', rowTint)}>
        <td className="px-2 py-2 border-r border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
          <div className="pt-0.5" title="Actual sheet row number — matches the source file">
            Row {dec.sourceRowIndex}
          </div>
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.discipline || null}
            inherited={row.synthesis.disciplineFilled}
          />
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.contact || null}
            strong
            placeholder="no name"
          />
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.company || null}
            inherited={row.synthesis.companyFilled}
            placeholder="no company"
          />
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.phone || null}
            synthesized={row.synthesis.phoneSplit}
            failed={row.synthesis.phoneSplitFailed}
          />
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.mobile || null}
            synthesized={row.synthesis.phoneSplit}
          />
        </td>
        <td className="px-2 py-2">
          <PreviewCell
            value={dec.values.email || null}
            synthesized={row.synthesis.emailSplit}
            failed={row.synthesis.emailSplitFailed}
          />
        </td>
        <td className="px-2 py-2">
          {/* IMP-4 fills this via extracted secondary contacts. IMP-1
              keeps the column so the layout is stable when IMP-4 lands. */}
          <PreviewCell value={null} placeholder="—" />
        </td>
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
      </tr>
      {isExpanded && (
        <tr className={cn('align-top', rowTint)}>
          <td colSpan={9} className="px-3 pt-0 pb-2.5">
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
        <div className="rounded-[14px] border border-red-200 bg-white divide-y divide-red-100 max-h-64 overflow-y-auto">
          <div className="bg-[#FAFBFC] px-3 py-1.5 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
            Errors
          </div>
          {result.perRow
            .filter((r) => r.status === 'error')
            .map((r) => (
              <div key={r.sourceRowIndex} className="px-3 py-2 text-[12px] text-red-700">
                <span className="font-mono text-[11px]">Row {r.sourceRowIndex}</span> · {r.message}
              </div>
            ))}
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
 */
function mappingsEqual(a: ContactsMapping, b: ContactsMapping): boolean {
  const fields = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const f of fields) {
    const av = a[f as ContactField] ?? '';
    const bv = b[f as ContactField] ?? '';
    if (av !== bv) return false;
  }
  return true;
}
