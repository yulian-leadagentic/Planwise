import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Upload, ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, XCircle, FileSpreadsheet } from 'lucide-react';

import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { Modal } from '@/components/shared/modal';

/* ─── BM2 Phase E — Excel BP + Contacts import wizard ────────────────────
   Four steps, driven off the /business-partners/bp-import/{parse,preview,commit}
   endpoints. State lives in the modal — the server keeps nothing between
   steps; the client sends the full row set back on preview + commit.

   Step 1: Upload  → POST /bp-import/parse — get headers + rows + auto-map.
   Step 2: Map     → user tweaks column-to-field mapping.
   Step 3: Preview → POST /bp-import/preview — per-row dedup + resolution.
                     Conflict rows may need a link-vs-create decision.
   Step 4: Commit  → POST /bp-import/commit — persist. Show a summary. */

type WizardField =
  | 'company'
  | 'contactName'
  | 'contactFirstName'
  | 'contactLastName'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'address'
  | 'roleOrDiscipline'
  | 'website'
  | 'notes';
type Mapping = Partial<Record<WizardField, string>>;

const WIZARD_FIELDS: ReadonlyArray<{ key: WizardField; label: string; hint?: string }> = [
  { key: 'company',            label: 'Company / Organization', hint: 'The org this row is about — creates or links a BP.' },
  { key: 'contactName',        label: 'Contact name (full)', hint: 'Full name; used when firstName/lastName not mapped.' },
  { key: 'contactFirstName',   label: 'Contact first name' },
  { key: 'contactLastName',    label: 'Contact last name' },
  { key: 'email',              label: 'Email', hint: 'Feeds the dedup — domain matches an existing org first, then normalized company name.' },
  { key: 'phone',              label: 'Phone' },
  { key: 'mobile',             label: 'Mobile' },
  { key: 'address',            label: 'Address' },
  { key: 'roleOrDiscipline',   label: 'Role / discipline', hint: 'Saved as titleAtB on the worker_of relationship.' },
  { key: 'website',            label: 'Website' },
  { key: 'notes',              label: 'Notes' },
];

interface ParsedRow { rowNum: number; raw: Record<string, string> }
interface Resolution {
  rowNum: number;
  values: {
    company: string | null;
    contactName: string | null;
    email: string | null;
    domain: string | null;
    isPersonalDomain: boolean;
    phone: string | null;
    mobile: string | null;
    address: string | null;
    roleOrDiscipline: string | null;
    website: string | null;
    notes: string | null;
  };
  org: {
    action: 'link' | 'create' | 'skip' | 'conflict';
    reason: string;
    matchedBpId?: number;
    matchedBpName?: string;
    matchReason?: 'domain' | 'name';
  };
  contact: {
    action: 'link' | 'create' | 'skip';
    reason: string;
    matchedBpId?: number;
    matchedBpName?: string;
  };
  errors: string[];
  warnings: string[];
}

interface Preview {
  headers: string[];
  mapping: Mapping;
  suggestedMapping: Mapping;
  rows: ParsedRow[];
  resolutions: Resolution[];
  summary: {
    totalRows: number;
    orgsToCreate: number;
    orgsToLink: number;
    orgConflicts: number;
    contactsToCreate: number;
    contactsToLink: number;
    contactsSkipped: number;
    errorRows: number;
  };
}

interface CommitResult {
  summary: {
    orgsCreated: number;
    orgsLinked: number;
    contactsCreated: number;
    contactsLinked: number;
    workerOfLinksCreated: number;
    skipped: number;
    errors: number;
  };
  perRow: Array<{ rowNum: number; status: 'created' | 'linked' | 'skipped' | 'error'; message?: string }>;
}

interface Decision {
  rowNum: number;
  // 'auto' = defer to the preview's suggested action.
  orgAction?: 'auto' | 'link' | 'create' | 'skip';
  orgBpId?: number;
}

type Step = 'upload' | 'map' | 'preview' | 'commit';

export function BpImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDirty = step !== 'upload' && step !== 'commit';

  // ─── Step 1: Upload + parse ───────────────────────────────────────
  const parse = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append('file', f);
      const r = await client.post('/business-partners/bp-import/parse', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return r.data as { headers: string[]; rows: ParsedRow[]; suggestedMapping: Mapping };
    },
    onSuccess: (data) => {
      setHeaders(data.headers);
      setRows(data.rows);
      setMapping(data.suggestedMapping);
      setStep('map');
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to read file'),
  });

  const onPickFile = (f: File | null) => {
    if (!f) return;
    setFile(f);
    parse.mutate(f);
  };

  // ─── Step 3: Preview (call server for resolution) ─────────────────
  const doPreview = useMutation({
    mutationFn: async () => {
      const r = await client.post('/business-partners/bp-import/preview', {
        headers, rows, mapping,
      });
      return r.data as Preview;
    },
    onSuccess: (data) => {
      setPreview(data);
      // Pre-seed decisions: for conflict rows, default to 'skip' so the
      // wizard doesn't accidentally create a duplicate — the user must
      // pick 'create anyway' or resolve.
      const seed: Record<number, Decision> = {};
      for (const res of data.resolutions) {
        if (res.org.action === 'conflict') {
          seed[res.rowNum] = { rowNum: res.rowNum, orgAction: 'skip' };
        }
      }
      setDecisions(seed);
      setStep('preview');
    },
    onError: (err: unknown) => notify.apiError(err, 'Preview failed'),
  });

  // ─── Step 4: Commit ─────────────────────────────────────────────
  const doCommit = useMutation({
    mutationFn: async () => {
      // Convert decisions into what the API accepts. Skip 'auto' —
      // omitting the decision defers to the preview's suggestion.
      const decisionList = Object.values(decisions)
        .filter((d) => d.orgAction && d.orgAction !== 'auto')
        .map((d) => ({
          rowNum: d.rowNum,
          orgAction: d.orgAction,
          orgBpId: d.orgBpId,
        }));
      const r = await client.post('/business-partners/bp-import/commit', {
        headers, rows, mapping, decisions: decisionList,
      });
      return r.data as CommitResult;
    },
    onSuccess: (data) => {
      setCommitResult(data);
      setStep('commit');
      const created = data.summary.orgsCreated + data.summary.contactsCreated;
      notify.success(`Imported — ${created} created, ${data.summary.errors} errors`, { code: 'BP-IMPORT-200' });
    },
    onError: (err: unknown) => notify.apiError(err, 'Commit failed'),
  });

  const canGoNext = useMemo(() => {
    if (step === 'upload') return !!file && !parse.isPending;
    if (step === 'map') {
      // At minimum a "company OR contact-identifying" column must be
      // mapped, otherwise no rows produce anything.
      const hasOrgSide = !!mapping.company || !!mapping.email;
      const hasContactSide = !!mapping.contactName || !!mapping.contactFirstName || !!mapping.contactLastName || !!mapping.email;
      return hasOrgSide || hasContactSide;
    }
    if (step === 'preview') return !!preview && !doCommit.isPending;
    return false;
  }, [step, file, parse.isPending, mapping, preview, doCommit.isPending]);

  const goNext = () => {
    if (step === 'upload') return; // upload triggers auto-advance
    if (step === 'map') {
      doPreview.mutate();
      return;
    }
    if (step === 'preview') {
      doCommit.mutate();
      return;
    }
  };

  const goBack = () => {
    if (step === 'map') setStep('upload');
    else if (step === 'preview') setStep('map');
  };

  const stepTitle: Record<Step, string> = {
    upload: '1 · Upload Excel',
    map: '2 · Map columns',
    preview: '3 · Preview + resolve',
    commit: '4 · Summary',
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-blue-600" /> Import BPs + Contacts — {stepTitle[step]}</span>}
      widthClass="w-[720px] max-w-[96vw]"
      isDirty={isDirty}
      dirtyWarning="Cancel this import? Any un-committed rows will be lost."
      footer={
        <div className="flex items-center gap-2">
          {step !== 'upload' && step !== 'commit' && (
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3 py-1.5"
          >
            {step === 'commit' ? 'Close' : 'Cancel'}
          </button>
          {step !== 'commit' && step !== 'upload' && (
            <button
              type="button"
              onClick={goNext}
              disabled={!canGoNext}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3 py-1.5 disabled:opacity-50"
            >
              {step === 'map' ? (doPreview.isPending ? 'Resolving…' : 'Preview') : (doCommit.isPending ? 'Committing…' : 'Commit')}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      }
    >
      <StepIndicator step={step} />

      {step === 'upload' && (
        <UploadStep
          file={file}
          isBusy={parse.isPending}
          fileInputRef={fileInputRef}
          onPick={onPickFile}
        />
      )}

      {step === 'map' && (
        <MapStep
          headers={headers}
          rowCount={rows.length}
          mapping={mapping}
          onChange={setMapping}
        />
      )}

      {step === 'preview' && preview && (
        <PreviewStep
          preview={preview}
          decisions={decisions}
          setDecisions={setDecisions}
        />
      )}

      {step === 'commit' && commitResult && (
        <CommitStep result={commitResult} />
      )}
    </Modal>
  );
}

/* ─── Step indicator ───────────────────────────────────────────────── */

function StepIndicator({ step }: { step: Step }) {
  const steps: Step[] = ['upload', 'map', 'preview', 'commit'];
  const idx = steps.indexOf(step);
  return (
    <ol className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-4">
      {steps.map((s, i) => (
        <li
          key={s}
          className={cn(
            'flex-1 rounded-md px-2 py-1 text-center border',
            i < idx && 'bg-emerald-50 text-emerald-700 border-emerald-200',
            i === idx && 'bg-blue-50 text-blue-700 border-blue-200',
            i > idx && 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
          )}
        >
          {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
        </li>
      ))}
    </ol>
  );
}

/* ─── Step 1: Upload ──────────────────────────────────────────────── */

function UploadStep({
  file, isBusy, fileInputRef, onPick,
}: {
  file: File | null;
  isBusy: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onPick: (f: File | null) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-slate-600 dark:text-slate-300">
        Upload an .xlsx workbook with contacts / organizations. The first sheet's row 1 must be headers. The wizard's next step lets you map each column to a canonical field (company, email, contact name, …).
      </p>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isBusy}
        className={cn(
          'w-full flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-10 px-6 transition-colors',
          isBusy
            ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 cursor-wait'
            : 'border-slate-300 dark:border-slate-600 hover:border-blue-500 hover:bg-blue-50/40',
        )}
      >
        <Upload className="h-8 w-8 text-slate-400 dark:text-slate-500" />
        <div className="text-center">
          <p className="text-[14px] font-semibold text-slate-700 dark:text-slate-200">
            {file ? file.name : 'Choose an .xlsx file'}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            {isBusy ? 'Reading…' : 'Max 5 MB · first sheet is parsed'}
          </p>
        </div>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="hidden"
      />
    </div>
  );
}

/* ─── Step 2: Column mapping ──────────────────────────────────────── */

function MapStep({
  headers, rowCount, mapping, onChange,
}: {
  headers: string[];
  rowCount: number;
  mapping: Mapping;
  onChange: (m: Mapping) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-slate-500 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-200">{rowCount}</span> data rows · <span className="font-semibold text-slate-700 dark:text-slate-200">{headers.length}</span> columns. Map each canonical field to a column from your sheet. Leave a field blank to skip it.
      </p>
      <div className="max-h-[52vh] overflow-y-auto -mx-2 px-2 space-y-2">
        {WIZARD_FIELDS.map((f) => (
          <div key={f.key} className="grid grid-cols-[180px_1fr] gap-3 items-center">
            <div>
              <label className="text-[12px] font-semibold text-slate-700 dark:text-slate-200 block">{f.label}</label>
              {f.hint && <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight mt-0.5">{f.hint}</p>}
            </div>
            <select
              value={mapping[f.key] ?? ''}
              onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value || undefined })}
              className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="">— skip —</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Step 3: Preview + conflict resolution ───────────────────────── */

function PreviewStep({
  preview, decisions, setDecisions,
}: {
  preview: Preview;
  decisions: Record<number, Decision>;
  setDecisions: React.Dispatch<React.SetStateAction<Record<number, Decision>>>;
}) {
  const s = preview.summary;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <SummaryTile label="Rows"           value={s.totalRows}      tone="neutral" />
        <SummaryTile label="Orgs · create"  value={s.orgsToCreate}   tone="emerald" />
        <SummaryTile label="Orgs · link"    value={s.orgsToLink}     tone="blue" />
        <SummaryTile label="Conflicts"      value={s.orgConflicts}   tone="amber" />
        <SummaryTile label="Contacts · new" value={s.contactsToCreate} tone="emerald" />
        <SummaryTile label="Contacts · link" value={s.contactsToLink}  tone="blue" />
        <SummaryTile label="Skipped contacts" value={s.contactsSkipped} tone="neutral" />
        <SummaryTile label="Errors"         value={s.errorRows}      tone="red" />
      </div>

      <div className="max-h-[46vh] overflow-y-auto -mx-2 px-2 border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {preview.resolutions.map((r) => (
          <PreviewRow
            key={r.rowNum}
            row={r}
            decision={decisions[r.rowNum]}
            onDecide={(patch) => setDecisions((prev) => ({
              ...prev,
              [r.rowNum]: { ...prev[r.rowNum], ...patch, rowNum: r.rowNum },
            }))}
          />
        ))}
      </div>
      {s.orgConflicts > 0 && (
        <p className="text-[11px] text-amber-700 flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" /> Conflict rows default to <strong>skip</strong>. Switch each to "create anyway" or "link to existing" before committing.
        </p>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'emerald' | 'blue' | 'amber' | 'red' }) {
  const bg = {
    neutral: 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
  }[tone];
  return (
    <div className={cn('rounded-md border px-2 py-1.5', bg)}>
      <p className="text-[10px] uppercase font-semibold tracking-wide opacity-70">{label}</p>
      <p className="text-[16px] font-bold tabular-nums">{value}</p>
    </div>
  );
}

function PreviewRow({
  row, decision, onDecide,
}: {
  row: Resolution;
  decision: Decision | undefined;
  onDecide: (patch: Partial<Decision>) => void;
}) {
  const orgAction: 'auto' | 'link' | 'create' | 'skip' = decision?.orgAction ?? 'auto';
  const effectiveOrgAction = orgAction === 'auto' ? row.org.action : orgAction;
  const isConflict = row.org.action === 'conflict';

  return (
    <div className={cn('px-3 py-2 grid grid-cols-[70px_1fr_180px] gap-2 items-start text-[12px]', row.errors.length > 0 && 'bg-red-50/40')}>
      <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500 text-[10px]">row {row.rowNum}</span>
      <div className="min-w-0">
        <p className="font-semibold text-slate-800 dark:text-slate-100 truncate">
          {row.values.company ?? <span className="italic text-slate-400 dark:text-slate-500">no company</span>}
          {row.values.contactName && <span className="text-slate-500 dark:text-slate-400"> · {row.values.contactName}</span>}
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {row.values.email ?? <span className="italic text-slate-400 dark:text-slate-500">no email</span>}
          {row.values.domain && !row.values.isPersonalDomain && <span className="text-emerald-600"> · @{row.values.domain}</span>}
          {row.values.domain && row.values.isPersonalDomain && <span className="text-amber-600"> · personal @{row.values.domain}</span>}
        </p>
        <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
          org: <ActionBadge action={effectiveOrgAction} /> {row.org.reason}
          {row.org.matchedBpName && <> — <span className="font-semibold">{row.org.matchedBpName}</span></>}
        </p>
        <p className="text-[10px] text-slate-500 dark:text-slate-400">
          contact: <ActionBadge action={row.contact.action} /> {row.contact.reason}
          {row.contact.matchedBpName && <> — <span className="font-semibold">{row.contact.matchedBpName}</span></>}
        </p>
        {row.errors.map((e) => (
          <p key={e} className="text-[10px] text-red-700 mt-0.5"><XCircle className="inline h-3 w-3" /> {e}</p>
        ))}
        {row.warnings.map((w) => (
          <p key={w} className="text-[10px] text-amber-700 mt-0.5"><AlertTriangle className="inline h-3 w-3" /> {w}</p>
        ))}
      </div>
      {/* Per-row override — only shown for conflict rows (others are auto). */}
      {isConflict ? (
        <select
          value={orgAction}
          onChange={(e) => onDecide({ orgAction: e.target.value as Decision['orgAction'] })}
          className="w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px]"
        >
          <option value="skip">Skip this row</option>
          <option value="create">Create new BP anyway</option>
          {row.org.matchedBpId && <option value="link">Link to matched BP</option>}
        </select>
      ) : (
        <span className="text-[10px] text-slate-400 dark:text-slate-500 italic pt-1">auto</span>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const cls = {
    create: 'bg-emerald-100 text-emerald-700',
    link: 'bg-blue-100 text-blue-700',
    conflict: 'bg-amber-100 text-amber-700',
    skip: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  }[action] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
  return <span className={cn('inline-block rounded px-1 py-0.5 font-mono text-[9px]', cls)}>{action}</span>;
}

/* ─── Step 4: Commit summary ──────────────────────────────────────── */

function CommitStep({ result }: { result: CommitResult }) {
  const s = result.summary;
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex items-center gap-3">
        <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
        <div>
          <p className="text-[14px] font-semibold text-emerald-800">Import complete</p>
          <p className="text-[12px] text-emerald-700">
            {s.orgsCreated + s.orgsLinked} orgs · {s.contactsCreated + s.contactsLinked} contacts · {s.workerOfLinksCreated} worker-of links{s.errors > 0 ? ` · ${s.errors} errors` : ''}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <SummaryTile label="Orgs created"     value={s.orgsCreated}     tone="emerald" />
        <SummaryTile label="Orgs linked"      value={s.orgsLinked}      tone="blue" />
        <SummaryTile label="Contacts created" value={s.contactsCreated} tone="emerald" />
        <SummaryTile label="Contacts linked" value={s.contactsLinked}  tone="blue" />
        <SummaryTile label="Worker-of links" value={s.workerOfLinksCreated} tone="blue" />
        <SummaryTile label="Skipped"         value={s.skipped}         tone="neutral" />
        <SummaryTile label="Errors"          value={s.errors}          tone="red" />
      </div>
      {result.perRow.filter((r) => r.status === 'error').length > 0 && (
        <div className="max-h-40 overflow-y-auto border border-red-200 rounded-lg divide-y divide-red-100">
          {result.perRow.filter((r) => r.status === 'error').map((r) => (
            <p key={r.rowNum} className="px-3 py-1 text-[11px] text-red-700">
              <span className="font-mono">row {r.rowNum}:</span> {r.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
