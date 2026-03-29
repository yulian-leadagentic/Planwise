import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';

export function CostReportPage() {
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]);
  const [to, setTo] = useState(new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0]);

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'cost', from, to],
    queryFn: () => client.get('/reports/cost/by-project', { params: { from, to } }).then((r) => r.data.data),
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost Report"
        description="Labor and expense costs by project"
        actions={
          <button className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            <Download className="h-4 w-4" /> Export
          </button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <div>
          <label className="block text-xs text-muted-foreground">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No cost data for this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Project</th>
                <th className="px-4 py-3 text-right font-medium">Labor</th>
                <th className="px-4 py-3 text-right font-medium">Expenses</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Budget</th>
                <th className="px-4 py-3 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any, i: number) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{row.projectName}</td>
                  <td className="px-4 py-3 text-right">${Number(row.laborCost).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">${Number(row.expenseCost).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-medium">${Number(row.totalCost).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{row.budgetAmount ? `$${Number(row.budgetAmount).toLocaleString()}` : '—'}</td>
                  <td className={`px-4 py-3 text-right ${row.variance && row.variance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {row.variance != null ? `$${Number(row.variance).toLocaleString()}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-medium">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right">${Number(totals.laborCost).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">${Number(totals.expenseCost).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">${Number(totals.totalCost).toLocaleString()}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
