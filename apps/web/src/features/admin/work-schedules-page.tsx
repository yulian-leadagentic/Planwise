import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { TableSkeleton } from '@/components/shared/loading-skeleton';
import client from '@/api/client';
import { toast } from 'sonner';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function WorkSchedulesPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('Regular Shift');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [shiftStart, setShiftStart] = useState('08:00');
  const [shiftEnd, setShiftEnd] = useState('17:00');
  const [breakMinutes, setBreakMinutes] = useState(60);
  const [userId, setUserId] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'work-schedules'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/work-schedules').then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => client.post('/work-schedules', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'work-schedules'] });
      toast.success('Schedule created');
      setShowForm(false);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error?.message || 'Failed to create schedule'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      userId,
      name,
      dayOfWeek,
      shiftStart,
      shiftEnd,
      breakMinutes,
      effectiveFrom: new Date().toISOString().split('T')[0],
    });
  };

  const schedules = data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Work Schedules"
        description="Configure employee work schedules and shifts"
        actions={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> Add Schedule
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Schedule Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Day of Week</label>
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(+e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">User ID</label>
              <input type="number" value={userId} onChange={(e) => setUserId(+e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Shift Start</label>
              <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Shift End</label>
              <input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Break (minutes)</label>
              <input type="number" value={breakMinutes} onChange={(e) => setBreakMinutes(+e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
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
        <TableSkeleton rows={5} cols={6} />
      ) : schedules.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No work schedules configured yet. Click "Add Schedule" to create one.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Day</th>
                <th className="px-4 py-3 font-medium">Shift Start</th>
                <th className="px-4 py-3 font-medium">Shift End</th>
                <th className="px-4 py-3 font-medium">Break</th>
                <th className="px-4 py-3 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s: any) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3">{DAYS[s.dayOfWeek] ?? s.dayOfWeek}</td>
                  <td className="px-4 py-3">{s.shiftStart}</td>
                  <td className="px-4 py-3">{s.shiftEnd}</td>
                  <td className="px-4 py-3">{s.breakMinutes}min</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {s.isActive ? 'Active' : 'Inactive'}
                    </span>
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
