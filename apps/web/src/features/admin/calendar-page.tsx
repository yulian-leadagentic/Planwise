import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const TYPE_STYLES: Record<string, string> = {
  holiday: 'bg-red-100 text-red-700',
  company_day_off: 'bg-amber-100 text-amber-700',
  half_day: 'bg-blue-100 text-blue-700',
  special: 'bg-purple-100 text-purple-700',
};

export function CalendarDaysPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('holiday');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'calendar'],
    queryFn: () => client.get('/calendar').then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: { date: string; name: string; type: string }) =>
      client.post('/calendar', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      toast.success('Calendar day created');
      setShowForm(false);
      setDate('');
      setName('');
      setType('holiday');
    },
    onError: () => toast.error('Failed to create calendar day'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => client.delete(`/calendar/${id}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'calendar'] });
      toast.success('Calendar day deleted');
    },
    onError: () => toast.error('Failed to delete'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!date || !name.trim()) return;
    createMutation.mutate({ date, name: name.trim(), type });
  };

  const days = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar Days"
        description="Manage holidays and company days off"
        actions={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> Add Day
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Date *</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Year" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="holiday">Holiday</option>
                <option value="company_day_off">Company Day Off</option>
                <option value="half_day">Half Day</option>
                <option value="special">Special</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">Cancel</button>
          </div>
        </form>
      )}

      {isLoading ? (
        <TableSkeleton rows={5} cols={5} />
      ) : days.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No calendar days configured yet. Click "Add Day" to create one.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Applies To</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d: any) => (
                <tr key={d.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{new Date(d.date).toLocaleDateString()}</td>
                  <td className="px-4 py-3">{d.name}</td>
                  <td className="px-4 py-3">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TYPE_STYLES[d.type] ?? 'bg-gray-100 text-gray-700')}>
                      {d.type?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{d.appliesTo?.replace(/_/g, ' ') ?? 'all'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => { if (confirm(`Delete "${d.name}"?`)) deleteMutation.mutate(d.id); }} className="text-xs text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
