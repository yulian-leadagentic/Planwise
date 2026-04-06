import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from '@/lib/notify';
import { timeApi } from '@/api/time.api';
import type { ClockInPayload, ClockOutPayload, TimeEntryPayload, WeeklyGridQuery } from '@/api/time.api';

export function useClockStatus() {
  return useQuery({
    queryKey: ['clock-status'],
    queryFn: () => timeApi.clockStatus(),
    refetchInterval: 60 * 1000,
  });
}

export function useClockIn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload?: ClockInPayload) => timeApi.clockIn(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clock-status'] });
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success('Clocked in', { code: 'TIME-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to clock in');
    },
  });
}

export function useClockOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload?: ClockOutPayload) => timeApi.clockOut(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clock-status'] });
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success('Clocked out', { code: 'TIME-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to clock out');
    },
  });
}

export function useTimeEntries(params?: { date?: string; weekStart?: string; projectId?: number; taskId?: number }) {
  return useQuery({
    queryKey: ['time', 'entries', params],
    queryFn: () => timeApi.listEntries(params),
  });
}

export function useCreateTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: TimeEntryPayload) => timeApi.createEntry(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success('Time entry created', { code: 'TIME-CREATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to create time entry');
    },
  });
}

export function useUpdateTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<TimeEntryPayload> & { id: number }) =>
      timeApi.updateEntry(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success('Time entry updated', { code: 'TIME-UPDATE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to update time entry');
    },
  });
}

export function useDeleteTimeEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => timeApi.deleteEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time'] });
      notify.success('Time entry deleted', { code: 'TIME-DELETE-200' });
    },
    onError: (err: any) => {
      notify.apiError(err, 'Failed to delete time entry');
    },
  });
}

export function useWeeklyGrid(params: WeeklyGridQuery) {
  return useQuery({
    queryKey: ['time', 'weekly-grid', params],
    queryFn: () => timeApi.weeklyGrid(params),
    enabled: !!params.weekStart,
  });
}

export function useDailyBreakdown(weekStart: string) {
  return useQuery({
    queryKey: ['time', 'daily-breakdown', weekStart],
    queryFn: () => timeApi.dailyBreakdown({ weekStart }),
    enabled: !!weekStart,
  });
}

export function useWorkSchedules(userId?: number) {
  return useQuery({
    queryKey: ['time', 'schedules', userId],
    queryFn: () => timeApi.listSchedules(userId),
  });
}

export function useCalendarDays(params?: { year?: number; month?: number }) {
  return useQuery({
    queryKey: ['time', 'calendar-days', params],
    queryFn: () => timeApi.listCalendarDays(params),
  });
}

export function useTeamClockDashboard() {
  return useQuery({
    queryKey: ['time', 'team-dashboard'],
    queryFn: () => timeApi.teamDashboard(),
    refetchInterval: 60 * 1000,
  });
}
