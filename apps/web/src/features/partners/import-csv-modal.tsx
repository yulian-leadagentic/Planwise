import { useState, useRef, useEffect } from 'react';
import { X, Upload, AlertCircle, CheckCircle, Download } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

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
  const [file, setFile] = useState<File | null>(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('No file selected');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('skipExisting', String(skipExisting));
      fd.append('dryRun', String(dryRun));
      return client
        .post<ImportResult | { data: ImportResult }>('/business-partners/import', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        .then((r) => (r.data as any)?.data ?? r.data);
    },
    onSuccess: (res: ImportResult) => {
      setResult(res);
      if (!dryRun) {
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
    }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[640px] max-w-[92vw] max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Import Business Partners (CSV)</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-[12px] text-slate-600 space-y-2">
            <p>
              <strong>Required columns:</strong> <code className="bg-slate-100 px-1 rounded">partner_type</code> ({'"person"'} or {'"organization"'}).
            </p>
            <p>
              <strong>Optional:</strong> <code className="bg-slate-100 px-1 rounded">first_name</code>, <code className="bg-slate-100 px-1 rounded">last_name</code>, <code className="bg-slate-100 px-1 rounded">company_name</code>, <code className="bg-slate-100 px-1 rounded">tax_id</code>, <code className="bg-slate-100 px-1 rounded">email</code>, <code className="bg-slate-100 px-1 rounded">phone</code>, <code className="bg-slate-100 px-1 rounded">mobile</code>, <code className="bg-slate-100 px-1 rounded">address</code>, <code className="bg-slate-100 px-1 rounded">website</code>, <code className="bg-slate-100 px-1 rounded">notes</code>, <code className="bg-slate-100 px-1 rounded">roles</code> (comma-separated codes like {'"employee,consultant"'}).
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
              className="w-full rounded-lg border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50/30 p-6 flex flex-col items-center gap-2 text-slate-600"
            >
              <Upload className="h-6 w-6 text-slate-400" />
              <span className="text-sm font-medium">{file ? file.name : 'Click to choose a CSV file'}</span>
              {file && <span className="text-[11px] text-slate-400">{(file.size / 1024).toFixed(1)} KB</span>}
            </button>
          </div>

          <div className="flex flex-col gap-2 text-sm text-slate-700">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
              <span><strong>Dry run</strong> — validate only, don't write anything</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
              <span>Skip rows whose email already exists (otherwise treat as errors)</span>
            </label>
          </div>

          {result && (
            <div className="rounded-lg border border-slate-200 p-3 space-y-2">
              <div className="flex items-center gap-4 text-[13px]">
                <div className="flex items-center gap-1.5">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                  <span><strong>{result.summary.created}</strong> {dryRun ? 'would be created' : 'created'}</span>
                </div>
                <div className="text-slate-500">
                  · {result.summary.skipped} skipped
                </div>
                {result.summary.errors > 0 && (
                  <div className="flex items-center gap-1.5 text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    <span><strong>{result.summary.errors}</strong> errors</span>
                  </div>
                )}
                <div className="ml-auto text-slate-500">{result.summary.total} rows total</div>
              </div>
              {result.errors.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded bg-red-50 px-3 py-2 text-[12px] text-red-700 space-y-0.5">
                  {result.errors.slice(0, 25).map((e, i) => (
                    <div key={i}>
                      <span className="font-mono">row {e.row}:</span> {e.reason}
                    </div>
                  ))}
                  {result.errors.length > 25 && <div className="italic text-red-500">… and {result.errors.length - 25} more</div>}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Close</button>
            <button
              onClick={() => importMutation.mutate()}
              disabled={!file || importMutation.isPending}
              className={cn(
                'text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50',
                dryRun ? 'bg-slate-700 hover:bg-slate-800' : 'bg-blue-600 hover:bg-blue-700',
              )}
            >
              {importMutation.isPending ? 'Processing...' : dryRun ? 'Run Dry Run' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
