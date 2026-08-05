/**
 * Bulk Excel-import wizard. Four steps in one page (no real routes for
 * each step — wizard state lives in this component so the back button
 * is "step backward", not "page back"):
 *
 *   1. Pick target (employees / partners / contacts)
 *   2. Upload + parse + preview
 *   3. Validate + map columns + show per-row diagnostics
 *   4. Commit (with mode selector) + result
 *
 * Per-entity permissions are checked client-side to disable the wrong
 * target cards; the server enforces the real gate. M1 only ships
 * employees — partners + contacts are visible but disabled with a "M2
 * coming soon" hint.
 */
import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, ArrowLeft, ArrowRight, Download, History as HistoryIcon, Users, Building2, Contact as ContactIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { dataImportApi, type ImportTarget, type ImportMode, type ValidationResponse } from '@/api/data-import.api';

type WizardStep = 'pick' | 'upload' | 'review' | 'done';

const TARGETS: Array<{
  key: ImportTarget;
  label: string;
  description: string;
  icon: any;
  // M1-only: which targets are actually shipped vs greyed out.
  available: boolean;
}> = [
  {
    key: 'users',
    label: 'Employees',
    description: 'Create employee accounts with role, seniority, and employment dates. Sets up the seniority history row automatically.',
    icon: Users,
    available: true,
  },
  {
    key: 'partners',
    label: 'Customers & Suppliers',
    description: 'Business partners — customers, suppliers, consultants. Ships in M2.',
    icon: Building2,
    available: false,
  },
  {
    key: 'contacts',
    label: 'Customer Contacts',
    description: 'Contact people attached to existing customers. Ships in M3.',
    icon: ContactIcon,
    available: false,
  },
];

export function DataImportPage() {
  const { can } = usePermissions();
  const [step, setStep] = useState<WizardStep>('pick');
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [mode, setMode] = useState<ImportMode>('insert');
  const [commitResult, setCommitResult] = useState<{
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
    importId: number;
  } | null>(null);

  const validateMutation = useMutation({
    mutationFn: (args: { target: ImportTarget; file: File }) =>
      dataImportApi.validate(args.target, args.file),
    onSuccess: (data) => {
      setValidation(data);
      setStep('review');
    },
    onError: (err: any) => notify.apiError(err, 'Validation failed'),
  });

  const commitMutation = useMutation({
    mutationFn: (args: { target: ImportTarget; file: File; mode: ImportMode }) =>
      dataImportApi.commit(args.target, args.file, args.mode),
    onSuccess: (data) => {
      setCommitResult({
        createdCount: data.summary.createdCount,
        updatedCount: data.summary.updatedCount,
        skippedCount: data.summary.skippedCount,
        errorCount: data.summary.errorCount,
        importId: data.import.id,
      });
      setStep('done');
      const ok = data.summary.errorCount === 0;
      notify[ok ? 'success' : 'warning'](
        ok
          ? `Created ${data.summary.createdCount} ${target} successfully`
          : `Completed with ${data.summary.errorCount} errors. See the history page.`,
        { code: 'IMPORT-COMMIT' },
      );
    },
    onError: (err: any) => notify.apiError(err, 'Import failed'),
  });

  // Reset wizard back to the start (used after success or "Import another")
  const reset = () => {
    setTarget(null);
    setFile(null);
    setValidation(null);
    setMode('insert');
    setCommitResult(null);
    setStep('pick');
  };

  const canCommit = useMemo(() => {
    if (!validation) return false;
    // M1 rule: don't let the user commit if there are validation errors.
    // Existing-conflicts are OK in insert-only (they become skips).
    return validation.summary.errors === 0;
  }, [validation]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Data Import"
          description="Bulk-load employees, partners, and contacts from Excel."
        />
        <Link
          to="/admin/data-import/history"
          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
        >
          <HistoryIcon className="h-3.5 w-3.5" />
          Import History
        </Link>
      </div>

      {/* Step indicator */}
      <Stepper step={step} />

      {/* Step bodies */}
      {step === 'pick' && (
        <PickTargetStep
          onPick={(t) => {
            setTarget(t);
            setStep('upload');
          }}
          canSelect={(t) => can(`data-import/${t}`, 'write') || can('data-import', 'write')}
        />
      )}

      {step === 'upload' && target && (
        <UploadStep
          target={target}
          file={file}
          onFile={setFile}
          onBack={() => setStep('pick')}
          onValidate={() => {
            if (!file) return;
            validateMutation.mutate({ target, file });
          }}
          isValidating={validateMutation.isPending}
        />
      )}

      {step === 'review' && target && validation && file && (
        <ReviewStep
          target={target}
          validation={validation}
          mode={mode}
          onModeChange={setMode}
          onBack={() => setStep('upload')}
          onCommit={() => commitMutation.mutate({ target, file, mode })}
          canCommit={canCommit && !commitMutation.isPending}
          isCommitting={commitMutation.isPending}
        />
      )}

      {step === 'done' && commitResult && target && (
        <DoneStep
          target={target}
          result={commitResult}
          onAnother={reset}
        />
      )}
    </div>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────

function Stepper({ step }: { step: WizardStep }) {
  const order: WizardStep[] = ['pick', 'upload', 'review', 'done'];
  const idx = order.indexOf(step);
  const labels = ['Choose target', 'Upload', 'Review', 'Done'];
  return (
    <ol className="flex items-center gap-2 text-[12px]">
      {labels.map((lbl, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <li key={lbl} className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center justify-center w-6 h-6 rounded-full font-semibold text-[11px]',
                done && 'bg-emerald-500 text-white',
                active && 'bg-blue-600 text-white',
                !done && !active && 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={cn(active ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>{lbl}</span>
            {i < labels.length - 1 && <span className="text-slate-300 dark:text-slate-600">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Step 1: pick target ─────────────────────────────────────────────

function PickTargetStep({
  onPick,
  canSelect,
}: {
  onPick: (t: ImportTarget) => void;
  canSelect: (t: ImportTarget) => boolean;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {TARGETS.map((t) => {
        const allowed = t.available && canSelect(t.key);
        return (
          <button
            key={t.key}
            onClick={() => allowed && onPick(t.key)}
            disabled={!allowed}
            className={cn(
              'rounded-lg border p-5 text-left transition-shadow',
              allowed
                ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:shadow-md cursor-pointer'
                : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 opacity-60 cursor-not-allowed',
            )}
          >
            <div className="inline-flex p-2 rounded-lg bg-blue-100 text-blue-700 mb-3">
              <t.icon className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-sm">{t.label}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
            {!t.available && (
              <span className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                Coming soon
              </span>
            )}
            {t.available && !canSelect(t.key) && (
              <span className="mt-2 inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                Permission required
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Step 2: upload ──────────────────────────────────────────────────

function UploadStep({
  target,
  file,
  onFile,
  onBack,
  onValidate,
  isValidating,
}: {
  target: ImportTarget;
  file: File | null;
  onFile: (f: File | null) => void;
  onBack: () => void;
  onValidate: () => void;
  isValidating: boolean;
}) {
  const targetLabel = TARGETS.find((t) => t.key === target)?.label;

  const downloadTemplate = async () => {
    try {
      const blob = await dataImportApi.downloadTemplate(target);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `planwise-${target}-template.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      notify.apiError(e, 'Could not download template');
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Upload {targetLabel} spreadsheet</h2>
          <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-1">
            Need the format? Download the template, fill in your data, and upload it back.
          </p>
        </div>
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-blue-600 hover:bg-blue-50"
        >
          <Download className="h-3.5 w-3.5" />
          Download template
        </button>
      </div>

      <DropZone file={file} onFile={onFile} />

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[12px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <button
          onClick={onValidate}
          disabled={!file || isValidating}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
         aria-label="Continue">
          {isValidating ? 'Validating…' : 'Validate'}
          <ArrowRight className="h-3.5 w-3.5"  aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function DropZone({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      className={cn(
        'block rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors',
        drag ? 'border-blue-400 bg-blue-50' : 'border-slate-300 dark:border-slate-600 bg-slate-50/40 dark:bg-slate-800/40 hover:border-slate-400 dark:hover:border-slate-500',
      )}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
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
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      {file ? (
        <div className="flex items-center justify-center gap-3">
          <FileSpreadsheet className="h-8 w-8 text-emerald-600" />
          <div className="text-left">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{file.name}</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {(file.size / 1024).toFixed(1)} KB
            </div>
          </div>
          <button
            onClick={(e) => { e.preventDefault(); onFile(null); }}
            className="ml-2 text-[11px] text-slate-500 dark:text-slate-400 underline hover:text-red-600"
          >
            Remove
          </button>
        </div>
      ) : (
        <div>
          <Upload className="mx-auto h-10 w-10 text-slate-400 dark:text-slate-500" />
          <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            Drop your .xlsx file here, or click to browse
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Max 5 MB · up to 10,000 rows</p>
        </div>
      )}
    </label>
  );
}

// ─── Step 3: review ──────────────────────────────────────────────────

function ReviewStep({
  target,
  validation,
  mode,
  onModeChange,
  onBack,
  onCommit,
  canCommit,
  isCommitting,
}: {
  target: ImportTarget;
  validation: ValidationResponse;
  mode: ImportMode;
  onModeChange: (m: ImportMode) => void;
  onBack: () => void;
  onCommit: () => void;
  canCommit: boolean;
  isCommitting: boolean;
}) {
  const { summary, rows, expectedColumns, headers, canSeeFinance } = validation;

  // Missing columns from the template — surfaced as a warning so users
  // know which columns the importer can't fill.
  const missingColumns = expectedColumns.filter(
    (c) => !headers.includes(c) && !(c === 'Hourly Rate' && !canSeeFinance),
  );

  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
        <Stat label="Total rows" value={summary.total} tone="neutral" />
        <Stat label="Will create" value={summary.validForInsert} tone="ok" />
        <Stat label="Will skip (exists)" value={summary.conflictsExisting} tone="warn" />
        <Stat label="Errors" value={summary.errors} tone={summary.errors > 0 ? 'error' : 'neutral'} />
      </div>

      {/* Missing columns warning */}
      {missingColumns.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <strong>Missing columns:</strong> {missingColumns.join(', ')}. These fields will be left empty in created records.
          </div>
        </div>
      )}

      {/* Mode selector */}
      <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-center gap-3">
        <label className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">Conflict mode:</label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ImportMode)}
          className="rounded border border-slate-200 dark:border-slate-700 px-2 py-1 text-[12px] focus:border-blue-400 focus:outline-none"
        >
          <option value="insert">Insert-only — skip existing</option>
          <option value="upsert" disabled>Upsert — update existing + create new (M2)</option>
          <option value="update" disabled>Update-only (M2)</option>
        </select>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 ml-2">
          M1 supports insert-only. Upsert ships in M2.
        </span>
      </div>

      {/* Per-row table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
          Row-by-row preview {validation.truncated && '(first 500 shown)'}
        </div>
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase text-slate-500 dark:text-slate-400 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left w-12">#</th>
                <th className="px-3 py-2 text-left">Identifier</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Issues</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => {
                const ok = r.errors.length === 0 && !r.conflictsWithExisting;
                const isSkip = r.errors.length === 0 && r.conflictsWithExisting;
                const isErr = r.errors.length > 0;
                const identifier =
                  r.data?.email ?? r.data?.companyName ?? r.data?.taxId ?? '—';
                return (
                  <tr key={r.rowIndex} className={cn(isErr && 'bg-red-50/30')}>
                    <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.rowIndex}</td>
                    <td className="px-3 py-2 truncate max-w-[260px]">{identifier}</td>
                    <td className="px-3 py-2">
                      {ok && <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><CheckCircle2 className="h-3 w-3" />Create</span>}
                      {isSkip && <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">Skip (exists)</span>}
                      {isErr && <span className="inline-flex items-center gap-1 text-red-700 font-semibold"><AlertTriangle className="h-3 w-3" />Error</span>}
                    </td>
                    <td className="px-3 py-2">
                      {r.errors.length > 0 ? (
                        <ul className="space-y-0.5">
                          {r.errors.map((e, idx) => (
                            <li key={idx} className="text-red-700">
                              {e.field && <span className="font-semibold">{e.field}: </span>}
                              {e.message}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer / actions */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[12px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex items-center gap-3">
          {!canCommit && summary.errors > 0 && (
            <span className="text-[12px] text-red-600">
              Fix the {summary.errors} error{summary.errors === 1 ? '' : 's'} in your file before importing.
            </span>
          )}
          <button
            onClick={onCommit}
            disabled={!canCommit}
            className="flex items-center gap-1 rounded-md bg-blue-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isCommitting ? 'Importing…' : `Import ${summary.validForInsert} ${target}`}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'ok' | 'warn' | 'error' }) {
  const toneCls =
    tone === 'ok' ? 'text-emerald-600' :
    tone === 'warn' ? 'text-amber-600' :
    tone === 'error' ? 'text-red-600' : 'text-slate-700 dark:text-slate-200';
  return (
    <div>
      <div className={cn('text-2xl font-bold tabular-nums', toneCls)}>{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  );
}

// ─── Step 4: done ────────────────────────────────────────────────────

function DoneStep({
  target,
  result,
  onAnother,
}: {
  target: ImportTarget;
  result: { createdCount: number; skippedCount: number; errorCount: number; importId: number };
  onAnother: () => void;
}) {
  const ok = result.errorCount === 0;
  return (
    <div className={cn('rounded-lg border p-6', ok ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50')}>
      <div className="flex items-start gap-3">
        {ok ? (
          <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
        ) : (
          <AlertTriangle className="h-6 w-6 text-amber-600 shrink-0" />
        )}
        <div className="flex-1">
          <h2 className={cn('text-base font-bold', ok ? 'text-emerald-900' : 'text-amber-900')}>
            {ok ? 'Import complete' : 'Import finished with errors'}
          </h2>
          <p className="text-[12px] mt-1">
            Created <strong>{result.createdCount}</strong>, skipped <strong>{result.skippedCount}</strong>,
            errors <strong>{result.errorCount}</strong>.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Link
              to={`/admin/data-import/history`}
              className="rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              View import details
            </Link>
            <button
              onClick={onAnother}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700"
            >
              Import another file
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
