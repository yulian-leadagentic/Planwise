import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link as LinkIcon } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { notify } from '@/lib/notify';

// Object Numbering — admin assigns which NumberRange each entity kind
// uses. One range can serve multiple kinds; an admin can replace the
// assignment at any time. Historical issued codes aren't affected; only
// FUTURE creates use the new assignment.

interface NumberRangeOption {
  code: string;
  name: string | null;
  mode: 'auto' | 'manual' | 'external';
  prefix: string;
  isActive: boolean;
  preview: string | null;
}

interface EntityKindRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  numberRangeCode: string | null;
  sortOrder: number;
  isSystem: boolean;
  numberRange: NumberRangeOption | null;
}

export function ObjectNumberingPage() {
  const queryClient = useQueryClient();

  const { data: kinds = [], isLoading } = useQuery<EntityKindRow[]>({
    queryKey: ['admin', 'entity-kinds'],
    queryFn: () =>
      client.get('/admin/entity-kinds').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const { data: ranges = [] } = useQuery<NumberRangeOption[]>({
    queryKey: ['admin', 'number-ranges'],
    queryFn: () =>
      client.get('/admin/number-ranges').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const assign = useMutation({
    mutationFn: (vars: { id: number; numberRangeCode: string | null }) =>
      client
        .patch(`/admin/entity-kinds/${vars.id}`, { numberRangeCode: vars.numberRangeCode })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'entity-kinds'] });
      notify.success('Assignment updated', { code: 'OBJNUM-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to update assignment'),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Object Numbering"
        description="Assign which number range each object in the system draws codes from. The same range can serve several objects. Changing an assignment only affects FUTURE creates — historical codes stay as issued."
      />

      <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-[12px] text-slate-700 space-y-1">
        <p className="font-semibold text-slate-800">How it works</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>Each <strong>object</strong> below is something the system numbers (Persons, Organizations, Employees, Projects, …).</li>
          <li>The <strong>number range</strong> dropdown picks which sequence to draw codes from. Define ranges in <a className="text-blue-600 hover:underline" href="/admin/number-ranges">Number Ranges</a>.</li>
          <li>Range <strong>mode</strong> controls what happens at create time:
            <span className="ml-2 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-700">auto</span> system allocates next;
            <span className="ml-1 inline-flex rounded-full bg-blue-50 px-2 py-0.5 font-mono text-[10px] text-blue-700">manual</span> user types it;
            <span className="ml-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 font-mono text-[10px] text-amber-700">external</span> code from another system (optional regex).
          </li>
          <li>Leave assignment <strong>none</strong> to disable code generation for that object until you wire one up.</li>
        </ul>
      </div>

      {isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Object</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium w-72">Number range</th>
                <th className="px-4 py-3 font-medium w-48">Next code / shape</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-[10px] text-slate-400 mt-0.5">{k.code}</div>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-slate-500">{k.description ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={k.numberRangeCode ?? ''}
                        onChange={(e) => assign.mutate({ id: k.id, numberRangeCode: e.target.value || null })}
                        disabled={assign.isPending}
                        className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="">— Not assigned —</option>
                        {ranges.map((r) => (
                          <option key={r.code} value={r.code} disabled={!r.isActive}>
                            {r.code}{r.name ? ` — ${r.name}` : ''}{!r.isActive ? ' (inactive)' : ''}
                          </option>
                        ))}
                      </select>
                      {k.numberRange && <ModeBadge mode={k.numberRange.mode} />}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {k.numberRange ? (
                      k.numberRange.mode === 'auto' && k.numberRange.preview ? (
                        <span className="font-mono text-xs font-semibold text-slate-800">{k.numberRange.preview}</span>
                      ) : (
                        <span className="text-[11px] italic text-slate-400">
                          {k.numberRange.mode === 'manual' ? 'User-entered' : 'External system'}
                        </span>
                      )
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        <LinkIcon className="h-2.5 w-2.5" /> Not assigned
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {kinds.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-400 text-sm">
                    No entity kinds — schema seed missing.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: 'auto' | 'manual' | 'external' }) {
  const cls =
    mode === 'auto'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : mode === 'manual'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize', cls)}>
      {mode}
    </span>
  );
}
