import { useState, useRef } from 'react';
import { Upload, AlertCircle, CheckCircle, Download } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Modal } from '@/components/shared/modal';

interface ImportResult {
  summary: { total: number; created: number; skipped: number; errors: number };
  errors: { row: number; reason: string }[];
  created: { row: number; id: number; displayName: string }[];
}

const SAMPLE_CSV = `partner_type,first_name,last_name,company_name,email,phone,roles
person,Yossi,Cohen,Municipality A,yossi@example.com,+972-50-1234567,"employee,external_contact"
person,Maya,Levi,,maya@studio.com,+972-3-1111111,consultant
organization,,,Acme Construction,info@acme.example,+972-3-2222222,supplier
organization,,,Municipality B,office@city-b.gov.example,+972-2-3333333,customer`;

export function ImportCsvModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  // People UX U4 (P-18) — track whether the currently selected file has
  // a matching, error-free dry run.
  const [lastDryRun, setLastDryRun] = useState<{ file: File; errors: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importMutation = useMutation({
    mutationFn: async (isDryRun: boolean) => {
      if (!file) throw new Error('No file selected');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('skipExisting', String(skipExisting));
      fd.append('dryRun', String(isDryRun));
      return client
        .post<ImportResult | { data: ImportResult }>('/business-partners/import', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        .then((r) => (r.data as any)?.data ?? r.data);
    },
    onSuccess: (res: ImportResult, isDryRun: boolean) => {
      setResult(res);
      if (isDryRun && file) {
        setLastDryRun({ file, errors: res.summary.errors });
      }
      if (!isDryRun) {
        queryClient.invalidateQueries({ queryKey: ['business-partners'] });
        notify.success(`Imported ${res.summary.created} partner(s)`, { code: 'BP-IMPORT-200' });
      }
    },
    onError: (err: any) => notify.apiError(err, 'Import failed'),
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
      setLastDryRun(null);
    }
  };

  const runRealImport = async () => {
    const cleanDryRun =
      !!lastDryRun && lastDryRun.file === file && lastDryRun.errors === 0;
    if (!cleanDryRun) {
      const missing = !lastDryRun || lastDryRun.file !== file;
      const errorCount = lastDryRun && lastDryRun.file === file ? lastDryRun.errors : null;
      const message = missing
        ? "You haven't dry-run this file — importing writes rows without validating them first."
        : `The last dry run of this file reported ${errorCount} error${errorCount === 1 ? '' : 's'}. Importing anyway will skip the failing rows.`;
      const ok = await confirm(message, {
        title: 'Import for real?',
        confirmLabel: 'Import anyway',
        variant: 'danger',
      });
      if (!ok) return;
    }
    setDryRun(false);
    importMutation.mutate(false);
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'business-partners-sample.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import Organizations & Contacts (CSV)"
      widthClass="w-[640px] max-w-[92vw]"
      className="max-h-[90vh]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
          >
            Close
          </button>
          {!file ? (
            <span className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-300 rounded-md px-3 py-1.5 font-medium">
              Choose a CSV file first ↑
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { setDryRun(true); importMutation.mutate(true); }}
                disabled={importMutation.isPending}
                className="bg-slate-700 dark:bg-slate-600 hover:bg-slate-800 dark:hover:bg-slate-500 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
                title="Validate the file without writing anything"
              >
                {importMutation.isPending && dryRun ? 'Validating…' : 'Run Dry Run'}
              </button>
              <button
                type="button"
                onClick={runRealImport}
                disabled={importMutation.isPending}
                className={cn(
                  'text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50',
                  'bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500',
                )}
                title="Actually create the rows"
              >
                {importMutation.isPending && !dryRun
                  ? 'Importing…'
                  : result && result.summary.errors === 0
                    ? `Import ${result.summary.created} rows`
                    : 'Import'}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 p-3 text-[12px] text-slate-600 dark:text-slate-300 space-y-2">
          <p>
            <strong>Required columns:</strong>{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">partner_type</code> ({'"person"'} or {'"organization"'}).
          </p>
          <p>
            <strong>Optional:</strong>{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">first_name</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">last_name</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">company_name</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">tax_id</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">email</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">phone</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">mobile</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">address</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">website</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">notes</code>,{' '}
            <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">roles</code> (comma-separated codes like {'"employee,consultant"'}).
          </p>
          <button
            type="button"
            onClick={downloadSample}
            className="text-blue-600 hover:underline text-[12px] font-semibold flex items-center gap-1"
          >
            <Download className="h-3 w-3" /> Download sample CSV
          </button>
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/30 dark:hover:bg-blue-900/20 p-6 flex flex-col items-center gap-2 text-slate-600 dark:text-slate-300"
          >
            <Upload className="h-6 w-6 text-slate-400 dark:text-slate-500" />
            <span className="text-sm font-medium">{file ? file.name : 'Click to choose a CSV file'}</span>
            {file && <span className="text-[11px] text-slate-400 dark:text-slate-500">{(file.size / 1024).toFixed(1)} KB</span>}
          </button>
        </div>

        <div className="flex flex-col gap-2 text-sm text-slate-700 dark:text-slate-200">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
            <span><strong>Dry run</strong> — validate only, don't write anything</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600" />
            <span>Skip rows whose email already exists (otherwise treat as errors)</span>
          </label>
        </div>

        {result && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
            <div className="flex items-center gap-4 text-[13px]">
              <div className="flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4 text-emerald-600" />
                <span><strong>{result.summary.created}</strong> {dryRun ? 'would be created' : 'created'}</span>
              </div>
              <div className="text-slate-500 dark:text-slate-400">
                · {result.summary.skipped} skipped
              </div>
              {result.summary.errors > 0 && (
                <div className="flex items-center gap-1.5 text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  <span><strong>{result.summary.errors}</strong> errors</span>
                </div>
              )}
              <div className="ml-auto text-slate-500 dark:text-slate-400">{result.summary.total} rows total</div>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded bg-red-50 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-700 dark:text-red-300 space-y-0.5">
                {result.errors.slice(0, 25).map((e, i) => (
                  <div key={i}>
                    <span className="font-mono">row {e.row}:</span> {e.reason}
                  </div>
                ))}
                {result.errors.length > 25 && <div className="italic text-red-500 dark:text-red-400">… and {result.errors.length - 25} more</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
