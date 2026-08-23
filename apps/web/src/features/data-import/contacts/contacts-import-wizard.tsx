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
import {
  contactsImportApi,
  CONTACT_FIELDS,
  CONTACT_FIELD_LABELS,
  ContactField,
  ContactsMapping,
  DedupDecision,
  ExtractedSheet,
  MappingPreset,
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
}: {
  onDone?: () => void;
  /**
   * When the wizard is opened from a project context (e.g. deep-linked
   * via `/admin/data-import?target=contacts&projectId=42`) preselect
   * that project in the attach panel. Users can still clear it for a
   * global import.
   */
  defaultProjectId?: number | null;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [grades, setGrades] = useState<SheetGrade[]>([]);
  const [selectedSheetIdx, setSelectedSheetIdx] = useState<number>(0);
  const [mapping, setMapping] = useState<ContactsMapping>({});
  const [headerRowIndex, setHeaderRowIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, RowDecision>>({});
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
      setDecisions({});
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
    setCommitResult(null);
    // Re-apply prefill for "Import another file" — if the wizard was
    // deep-linked from a project, that context still holds. The role
    // effect above re-defaults after the project is re-set.
    setAttachToProjectId(defaultProjectId);
    setProjectRoleId(null);
    setStep('upload');
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
          onBack={reset}
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
          onBack={() => setStep(sheets.length > 1 ? 'sheet' : 'upload')}
          onNext={() => previewMutation.mutate()}
          isBusy={previewMutation.isPending}
        />
      )}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          decisions={decisions}
          onDecide={(idx, patch) =>
            setDecisions((prev) => ({
              ...prev,
              [idx]: { ...prev[idx], ...patch, sourceRowIndex: idx },
            }))
          }
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
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white p-6 space-y-4">
      <div>
        <h2 className="text-[15px] font-bold text-slate-900">Upload a contacts sheet</h2>
        <p className="text-[13px] text-slate-500 mt-1">
          Any .xlsx, .xls (legacy), .csv, .docx, or .pdf — the wizard sniffs the real file type
          (not the extension) and picks the right reader. No pre-formatting; you'll map columns in
          the next step.
        </p>
      </div>

      <label
        className={cn(
          'block rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition-colors',
          drag ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-slate-50 hover:border-slate-300',
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
          type="file"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          accept=".xlsx,.xls,.csv,.docx,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
        />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <FileSpreadsheet className="h-8 w-8 text-emerald-600" />
            <div className="text-left">
              <div className="text-sm font-semibold text-slate-800">{file.name}</div>
              <div className="text-[11px] text-slate-500">{(file.size / 1024).toFixed(1)} KB</div>
            </div>
          </div>
        ) : (
          <div>
            <Upload className="mx-auto h-10 w-10 text-slate-400" />
            <p className="mt-2 text-sm font-semibold text-slate-700">
              Drop your file here, or click to browse
            </p>
            <p className="text-[11px] text-slate-500 mt-1">Max 5 MB · triage never trusts the extension</p>
          </div>
        )}
      </label>

      {isBusy && (
        <p className="text-[13px] text-slate-500 flex items-center gap-2">
          <Sparkles className="h-4 w-4 animate-pulse text-blue-500" /> Sniffing file type, extracting sheets…
        </p>
      )}

      {triage?.kind === 'reject' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2">
          <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <div className="text-[13px] text-red-800">
            <strong>Cannot import this file</strong>
            <p className="mt-0.5">{triage.reason}</p>
          </div>
        </div>
      )}

      {triage && triage.kind !== 'reject' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-[13px] text-emerald-800">
            Extracted{' '}
            <strong>{triage.sheets.length}</strong>{' '}
            {triage.kind === 'docx-tables' ? 'table' : 'sheet'}
            {triage.sheets.length === 1 ? '' : 's'} via the{' '}
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-emerald-100">
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
    auto: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: '0-CLICK' },
    manual: { bg: 'bg-amber-50', text: 'text-amber-700', label: 'CONFIRM' },
    headerless: { bg: 'bg-blue-50', text: 'text-blue-700', label: 'EMAIL-ONLY' },
    'non-contact': { bg: 'bg-slate-100', text: 'text-slate-500', label: 'NON-CONTACT' },
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
                  <span className="ml-1 text-[10px] font-medium text-blue-600">·system</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-[14px] border border-slate-200 bg-white divide-y divide-slate-100">
        {CONTACT_FIELDS.map((field) => (
          <div key={field} className="grid grid-cols-[180px_1fr] items-center gap-4 px-4 py-3">
            <div>
              <label className="text-[13px] font-semibold text-slate-700">
                {CONTACT_FIELD_LABELS[field]}
              </label>
            </div>
            <select
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
        ))}
      </div>

      <div className="rounded-[14px] border border-slate-200 bg-white p-4">
        <div className="text-[13px] font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
          <SaveIcon className="h-4 w-4 text-slate-500" /> Save this mapping as a preset
        </div>
        <div className="flex gap-2">
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Preset name — e.g. Acme Q3 vendor list"
            className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none"
          />
          <button
            disabled={!presetName.trim() || Object.keys(mapping).length === 0}
            onClick={async () => {
              await onSavePreset(presetName.trim());
              setPresetName('');
            }}
            className="rounded-lg border border-slate-200 hover:border-slate-400 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 disabled:opacity-50"
          >
            Save preset
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-1.5">
          Presets are shared across the org — next vendor sheet with the same headers becomes
          0-click.
        </p>
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
  decisions: Record<number, RowDecision>;
  onDecide: (idx: number, patch: Partial<RowDecision>) => void;
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
  const conflicts = preview.decisions.filter((d) => d.org.action === 'conflict');
  const zeroClickEligible = s.eligible === s.totalRows && s.orgConflicts === 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Total rows" value={s.totalRows} />
        <SummaryTile label="Eligible" value={s.eligible} tone="ok" />
        <SummaryTile label="Below contract" value={s.belowContract} tone={s.belowContract > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Conflicts" value={s.orgConflicts} tone={s.orgConflicts > 0 ? 'warn' : 'neutral'} />
        <SummaryTile label="Orgs · create" value={s.orgsToCreate} tone="ok" />
        <SummaryTile label="Orgs · link" value={s.orgsToLink} tone="info" />
        <SummaryTile label="Contacts · create" value={s.contactsToCreate} tone="ok" />
        <SummaryTile label="Contacts · link" value={s.contactsToLink} tone="info" />
      </div>

      {(s.emailSplitRows > 0 || s.phoneSplitRows > 0 || s.companyFilledRows > 0 || s.disciplineFilledRows > 0) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-start gap-2 text-[12px] text-blue-800">
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
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-center gap-2 text-[12px] text-emerald-800">
          <Sparkles className="h-4 w-4" />
          <div>
            <strong>0-click eligible</strong> — every row meets the minimum contract and no
            conflicts remain. Click Commit to import.
          </div>
        </div>
      )}

      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        <div className="bg-[#FAFBFC] border-b border-slate-100 px-3 py-1.5 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em]">
          Row-by-row preview
        </div>
        <div className="max-h-[520px] overflow-y-auto divide-y divide-slate-50">
          {preview.decisions.map((d, i) => {
            const row = preview.resolvedRows[i];
            const dec = decisions[d.sourceRowIndex];
            const effectiveOrgAction = dec?.orgAction ?? d.org.action;
            return (
              <PreviewRow
                key={d.sourceRowIndex}
                dec={d}
                row={row}
                effectiveOrgAction={effectiveOrgAction}
                onDecide={(patch) => onDecide(d.sourceRowIndex, patch)}
              />
            );
          })}
        </div>
      </div>

      {conflicts.length > 0 && (
        <p className="text-[12px] text-amber-700 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" />{' '}
          <strong>{conflicts.length}</strong> rows need a decision — pick create / link / skip on
          each conflict below.
        </p>
      )}

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
          onClick={onBack}
          className="flex items-center gap-1 text-[13px] font-semibold text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <button
          onClick={onCommit}
          disabled={isBusy || s.eligible === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {isBusy ? 'Committing…' : `Commit ${s.eligible} rows`} <ArrowRight className="h-3.5 w-3.5" />
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
        person's <em>title-in-project</em>; the role-type here is the participation role. Leave
        both empty for a global import (creates BPs + worker_of only).
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
                  ? `— server fallback: ${fallbackDefault.name} —`
                  : '— no role · attach will be skipped —'}
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
      <div className="text-[10px] uppercase font-semibold tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-bold tabular-nums font-mono">{value}</div>
    </div>
  );
}

function PreviewRow({
  dec,
  row,
  effectiveOrgAction,
  onDecide,
}: {
  dec: DedupDecision;
  row: {
    sourceRowIndex: number;
    values: Partial<Record<ContactField, string>>;
    synthesis: {
      emailSplit?: boolean;
      phoneSplit?: boolean;
      companyFilled?: boolean;
      disciplineFilled?: boolean;
      emailSplitFailed?: boolean;
      phoneSplitFailed?: boolean;
    };
    extraEmails?: string[];
    extraPhones?: string[];
    errors: string[];
  };
  effectiveOrgAction: DedupDecision['org']['action'];
  onDecide: (patch: Partial<RowDecision>) => void;
}) {
  const isConflict = dec.org.action === 'conflict';
  const belowContract = !dec.meetsMinimumContract;
  return (
    <div
      className={cn(
        'grid grid-cols-[72px_1fr_180px] gap-3 px-3 py-2.5 text-[12px]',
        belowContract && 'bg-red-50/40',
      )}
    >
      <div className="font-mono text-[10px] text-slate-400 tabular-nums pt-1">
        row {dec.sourceRowIndex}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-slate-800">
            {dec.values.contact || <span className="italic text-slate-400">no name</span>}
          </span>
          <span className="text-slate-400">·</span>
          <SynthCell value={dec.values.company || null} inherited={row.synthesis.companyFilled} placeholder="no company" />
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
          {dec.values.email ? (
            <SynthCell
              value={dec.values.email}
              inherited={false}
              synthesized={row.synthesis.emailSplit}
              failed={row.synthesis.emailSplitFailed}
              title={
                row.synthesis.emailSplit
                  ? 'Split from a multi-email cell — first email chosen; overrides available.'
                  : row.synthesis.emailSplitFailed
                    ? 'Cell had a delimiter but one piece was not a valid email — routed to conflict.'
                    : undefined
              }
            />
          ) : (
            <span className="italic text-slate-400">no email</span>
          )}
          {dec.domain && !dec.isPersonalDomain && (
            <span className="font-mono text-emerald-600">·@{dec.domain}</span>
          )}
          {dec.domain && dec.isPersonalDomain && (
            <span className="font-mono text-amber-600">·personal @{dec.domain}</span>
          )}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
          {dec.values.mobile && (
            <>
              m:{' '}
              <SynthCell
                value={dec.values.mobile}
                inherited={false}
                synthesized={row.synthesis.phoneSplit}
              />
            </>
          )}
          {dec.values.phone && (
            <>
              t:{' '}
              <SynthCell
                value={dec.values.phone}
                inherited={false}
                synthesized={row.synthesis.phoneSplit}
              />
            </>
          )}
          {row.extraPhones && row.extraPhones.length > 0 && (
            <span className="text-slate-400">+{row.extraPhones.length} more</span>
          )}
          {dec.values.discipline && (
            <>
              ·{' '}
              <SynthCell value={dec.values.discipline} inherited={row.synthesis.disciplineFilled} />
            </>
          )}
        </div>
        <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
          <span>org:</span> <ActionBadge action={effectiveOrgAction} />
          <span className="text-slate-400 truncate">{dec.org.reason}</span>
          {dec.org.matchedBpName && (
            <span className="text-slate-500">→ <strong>{dec.org.matchedBpName}</strong></span>
          )}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
          <span>person:</span> <ActionBadge action={dec.contact.action} />
          <span className="text-slate-400 truncate">{dec.contact.reason}</span>
        </div>
        {dec.contractError && (
          <div className="text-[10px] text-red-700 mt-1 flex items-center gap-1">
            <XCircle className="h-3 w-3" /> {dec.contractError}
          </div>
        )}
        {row.errors.map((e, i) => (
          <div key={i} className="text-[10px] text-amber-700 mt-0.5 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> {e}
          </div>
        ))}
      </div>
      {isConflict ? (
        <div className="pt-1">
          <select
            value={effectiveOrgAction}
            onChange={(e) => onDecide({ orgAction: e.target.value as 'link' | 'create' | 'skip' })}
            className="w-full px-2 py-1 rounded-md border border-slate-200 bg-white text-[11px]"
          >
            <option value="conflict">— pick —</option>
            <option value="skip">Skip row</option>
            <option value="create">Create new org</option>
            {dec.org.matchedBpId && <option value="link">Link to matched BP</option>}
          </select>
        </div>
      ) : (
        <span className="text-[10px] text-slate-300 italic pt-1">auto</span>
      )}
    </div>
  );
}

function SynthCell({
  value,
  inherited,
  synthesized,
  failed,
  placeholder,
  title,
}: {
  value: string | null;
  inherited?: boolean;
  synthesized?: boolean;
  failed?: boolean;
  placeholder?: string;
  title?: string;
}) {
  if (!value) return <span className="italic text-slate-400">{placeholder ?? '—'}</span>;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        inherited && 'text-slate-500 underline decoration-dashed decoration-slate-300 underline-offset-2',
        synthesized && 'text-slate-700 bg-blue-50 rounded-[5px] px-1',
        failed && 'text-amber-800 bg-amber-50 rounded-[5px] px-1',
      )}
      title={
        title ??
        (inherited
          ? 'Inherited from a row above (forward-fill)'
          : synthesized
            ? 'Split from a multi-value cell'
            : failed
              ? 'Split failed — cell has a delimiter but a piece is invalid'
              : undefined)
      }
    >
      {value}
      {inherited && <sup className="text-[8px] font-bold text-blue-500 ml-0.5">FILL</sup>}
      {synthesized && !inherited && !failed && (
        <sup className="text-[8px] font-bold text-blue-500 ml-0.5">SPLIT</sup>
      )}
      {failed && <sup className="text-[8px] font-bold text-amber-700 ml-0.5">FAIL</sup>}
    </span>
  );
}

function ActionBadge({ action }: { action: string }) {
  const cfg = {
    create: 'bg-emerald-50 text-emerald-700',
    link: 'bg-blue-50 text-blue-700',
    conflict: 'bg-amber-50 text-amber-700',
    skip: 'bg-slate-100 text-slate-600',
  }[action] ?? 'bg-slate-100 text-slate-500';
  return (
    <span className={cn('font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-[5px]', cfg)}>
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
            {result.workerOfLinksCreated} worker-of links
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
            skipped (below-contract or user-marked "skip") or no role type was resolvable — pick
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
        <SummaryTile label="worker_of links" value={result.workerOfLinksCreated} tone="info" />
        {projectRequested && (
          <SummaryTile
            label={projectName ? `Attached · ${projectName}` : 'Attached to project'}
            value={result.projectAttached}
            tone={result.projectAttached > 0 ? 'ok' : 'warn'}
          />
        )}
        <SummaryTile label="Below contract" value={result.belowContract} tone="warn" />
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
                <span className="font-mono text-[10px]">row {r.sourceRowIndex}</span> · {r.message}
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
