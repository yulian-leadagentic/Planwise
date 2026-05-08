import { useState, useMemo, useRef, useEffect, useCallback, createContext, useContext } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, ArrowLeft, Trash2, Search, ChevronRight, ChevronDown, Copy, X, UserPlus, GripVertical, Layers, MessageSquare, Paperclip, Download, FileText, AlertTriangle, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { formatDuration } from '@/lib/date-utils';
import { notify } from '@/lib/notify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { planningApi, zonesApi, templatesApi } from '@/api/zones.api';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';
import { DiscussionDrawer } from '@/features/messaging/discussion-drawer';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── Feasibility Badge ───────────────────────────────────────────────────────

function FeasibilityBadge({ projectId }: { projectId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['feasibility', projectId],
    queryFn: () => client.get(`/projects/${projectId}/feasibility`).then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    enabled: !!projectId,
  });

  const progressQuery = useQuery({
    queryKey: ['progress', projectId],
    queryFn: () => client.get(`/projects/${projectId}/progress`).then((r) => r.data?.data ?? r.data),
    staleTime: 60 * 1000,
    enabled: !!projectId,
  });

  const progress = (progressQuery.data as any)?.overallProgress ?? 0;
  const feasibility = data as any;
  const status = feasibility?.status ?? 'UNKNOWN';

  const statusConfig: Record<string, { bg: string; text: string; label: string; icon: string }> = {
    OK: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'On Track', icon: '✓' },
    AT_RISK: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'At Risk', icon: '⚠' },
    IMPOSSIBLE: { bg: 'bg-red-100', text: 'text-red-700', label: 'Impossible', icon: '✗' },
    UNKNOWN: { bg: 'bg-slate-100', text: 'text-slate-500', label: 'Checking...', icon: '…' },
  };
  const cfg = statusConfig[status] || statusConfig.UNKNOWN;

  if (isLoading) return <span className="text-[11px] text-slate-400">Analyzing...</span>;

  return (
    <div className="flex items-center gap-3">
      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-slate-500">Progress</span>
        <div className="w-24 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              progress >= 80 ? 'bg-emerald-500' : progress >= 50 ? 'bg-blue-500' : progress >= 25 ? 'bg-amber-500' : 'bg-slate-400',
            )}
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
        <span className="text-[11px] font-semibold text-slate-700">{progress}%</span>
      </div>

      {/* Feasibility badge */}
      <div className={cn('flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[11px] font-bold', cfg.bg, cfg.text)}
        title={feasibility?.details ? `${feasibility.details.overloadedAssignees?.length ?? 0} overloaded, ${feasibility.details.blockedTasks?.length ?? 0} blocked, ${feasibility.details.unassignedTasks?.length ?? 0} unassigned` : ''}>
        <span>{cfg.icon}</span>
        <span>{cfg.label}</span>
        {feasibility?.details?.daysRemaining != null && (
          <span className="opacity-70 ml-1" title={`${feasibility.details.daysRemaining} days`}>
            ({formatDuration(feasibility.details.daysRemaining)} left)
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Status Badge Dropdown (clickable badge that opens status picker) ─────────

function StatusBadgeDropdown({
  taskId,
  currentStatus,
  projectId,
  selectedTaskIds,
}: {
  taskId: number;
  currentStatus: string;
  projectId: number;
  selectedTaskIds?: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const allStatuses = [
    { value: 'not_started', label: 'Not Started', bg: 'bg-slate-100', text: 'text-slate-600', dot: 'bg-slate-400' },
    { value: 'in_progress', label: 'In Progress', bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
    { value: 'in_review', label: 'In Review', bg: 'bg-violet-100', text: 'text-violet-700', dot: 'bg-violet-500' },
    { value: 'completed', label: 'Completed', bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
    { value: 'on_hold', label: 'On Hold', bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
    { value: 'cancelled', label: 'Cancelled', bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  ];

  const current = allStatuses.find((s) => s.value === currentStatus) ?? allStatuses[0];

  // Spreadsheet-style multi-edit: if this row is part of a multi-selection,
  // changing status propagates across all selected rows.
  const isBulk = !!(selectedTaskIds && selectedTaskIds.has(taskId) && selectedTaskIds.size > 1);
  const targetIds = isBulk ? Array.from(selectedTaskIds!) : [taskId];

  const handleChange = async (status: string) => {
    setOpen(false);
    if (!isBulk && status === currentStatus) return;
    try {
      if (isBulk) {
        const results = await Promise.allSettled(
          targetIds.map((id) => tasksApi.update(id, { status })),
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        if (ok > 0 && fail === 0) {
          notify.success(`Status set on ${ok} task${ok !== 1 ? 's' : ''}`, { code: 'TASK-BULK-STATUS-200' });
        } else if (ok > 0 && fail > 0) {
          notify.warning(`Updated ${ok}, ${fail} failed`, { code: 'TASK-BULK-STATUS-207' });
        } else {
          notify.error('Bulk status change failed', { code: 'TASK-BULK-STATUS-500' });
        }
      } else {
        await tasksApi.update(taskId, { status });
      }
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['feasibility', projectId] });
    } catch (err: any) {
      notify.apiError(err, 'Failed to change status');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={cn('inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[10px] font-bold cursor-pointer hover:ring-2 hover:ring-blue-300 transition-all', current.bg, current.text)}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full', current.dot)} />
        {current.label}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-lg border border-slate-200 bg-white shadow-xl py-1">
          {allStatuses.map((s) => (
            <button key={s.value} onClick={() => handleChange(s.value)}
              className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-slate-50', s.value === currentStatus && 'bg-blue-50')}>
              <span className={cn('w-2 h-2 rounded-full', s.dot)} />
              <span className="text-slate-700">{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Status Menu (quick status change via dropdown) ──────────────────────────

function StatusMenu({ taskId, currentStatus, projectId }: { taskId: number; currentStatus: string; projectId: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const statuses = [
    { value: 'not_started', label: 'Not Started', dot: 'bg-slate-400' },
    { value: 'in_progress', label: 'In Progress', dot: 'bg-blue-500' },
    { value: 'in_review', label: 'In Review', dot: 'bg-violet-500' },
    { value: 'completed', label: 'Completed', dot: 'bg-emerald-500' },
    { value: 'on_hold', label: 'On Hold', dot: 'bg-amber-500' },
    { value: 'cancelled', label: 'Cancelled', dot: 'bg-red-500' },
  ];

  const handleChange = async (status: string) => {
    try {
      await tasksApi.update(taskId, { status });
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      queryClient.invalidateQueries({ queryKey: ['feasibility', projectId] });
      queryClient.invalidateQueries({ queryKey: ['progress', projectId] });
      setOpen(false);
    } catch (err: any) {
      notify.apiError(err, 'Failed to change status');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Change status"
        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-slate-200 bg-white shadow-xl py-1">
          <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase">Set Status</div>
          {statuses.map((s) => (
            <button
              key={s.value}
              onClick={() => handleChange(s.value)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-slate-50',
                s.value === currentStatus && 'bg-blue-50 font-medium',
              )}
            >
              <span className={cn('w-2 h-2 rounded-full', s.dot)} />
              <span className="text-slate-700">{s.label}</span>
              {s.value === currentStatus && <span className="ml-auto text-[10px] text-blue-500">current</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Move To Menu (keyboard alternative for DnD) ────────────────────────────

function MoveToMenu({ taskId, currentZoneId, zones, projectId, onMoved }: {
  taskId: number; currentZoneId: number; zones: any[]; projectId: number; onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const flatZones = useMemo(() => {
    const result: any[] = [];
    function walk(z: any[], depth: number) {
      for (const zone of z) {
        result.push({ ...zone, depth });
        if (zone.children) walk(zone.children, depth + 1);
      }
    }
    walk(zones, 0);
    return result.filter((z) => z.id !== currentZoneId);
  }, [zones, currentZoneId]);

  const handleMove = async (targetZoneId: number) => {
    try {
      await tasksApi.reorder([{ id: taskId, sortOrder: 0, zoneId: targetZoneId }]);
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      notify.success('Task moved', { code: 'TASK-MOVE-200' });
      setOpen(false);
      onMoved();
    } catch (err: any) {
      notify.apiError(err, 'Failed to move task');
    }
  };

  if (flatZones.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Move to zone..."
        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
      >
        <Layers className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-56 rounded-lg border border-slate-200 bg-white shadow-xl py-1">
          <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase">Move to zone</div>
          {flatZones.map((z) => (
            <button
              key={z.id}
              onClick={() => handleMove(z.id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-slate-50"
              style={{ paddingLeft: `${12 + z.depth * 16}px` }}
            >
              <span className="text-slate-700">{z.name}</span>
              <span className="text-[10px] text-slate-400">{z.zoneType}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Task Attachment Button ──────────────────────────────────────────────────

function TaskAttachmentButton({ taskId, projectId }: { taskId: number; projectId: number }) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: attachments = [] } = useQuery({
    queryKey: ['task-attachments', taskId],
    queryFn: () => client.get(`/tasks/${taskId}/attachments`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
    enabled: open,
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', 'task-attachments');
        const uploadResult = await client.post('/files/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        }).then((r) => r.data?.data ?? r.data);

        await client.post(`/tasks/${taskId}/attachments`, {
          fileName: file.name,
          fileUrl: uploadResult.url,
          fileSize: file.size,
          mimeType: file.type,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['task-attachments', taskId] });
      notify.success('File attached', { code: 'FILE-UPLOAD-200' });
    } catch (err: any) {
      notify.apiError(err, 'Failed to upload file');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async (attachmentId: number) => {
    try {
      await client.delete(`/tasks/attachments/${attachmentId}`);
      queryClient.invalidateQueries({ queryKey: ['task-attachments', taskId] });
    } catch (err: any) {
      notify.apiError(err, 'Failed to remove');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Attachments"
        className={cn(
          'w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
          'text-slate-400 hover:text-amber-600 hover:bg-amber-50',
        )}
      >
        <Paperclip className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 rounded-[14px] border border-slate-200 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="border-b border-slate-100 px-4 py-3 flex items-center justify-between">
            <h4 className="text-[13px] font-semibold text-slate-800">Attachments</h4>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> {uploading ? 'Uploading...' : 'Add File'}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {attachments.length === 0 ? (
              <div className="py-6 text-center">
                <Paperclip className="mx-auto h-6 w-6 text-slate-300" />
                <p className="mt-1 text-[11px] text-slate-400">No attachments</p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 text-[11px] font-semibold text-blue-600 hover:text-blue-700"
                >
                  Upload a file
                </button>
              </div>
            ) : (
              <div className="divide-y divide-slate-50 py-1">
                {attachments.map((att: any) => (
                  <div key={att.id} className="flex items-center gap-2 px-4 py-2 hover:bg-slate-50">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-slate-700 truncate">{att.fileName}</p>
                      <p className="text-[10px] text-slate-400">
                        {att.fileSize ? `${Math.round(att.fileSize / 1024)}KB` : ''}
                        {att.uploader ? ` · ${att.uploader.firstName}` : ''}
                      </p>
                    </div>
                    <a href={att.fileUrl} target="_blank" rel="noopener noreferrer" className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50">
                      <Download className="w-3 h-3" />
                    </a>
                    <button onClick={() => handleRemove(att.id)} className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Task Discussion Button — opens the side Discussion drawer ──────────────

function TaskDiscussionButton({ taskId, taskName }: { taskId: number; taskName: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['messages', 'task-count', taskId],
    queryFn: () => client.get('/messages', { params: { entityType: 'task', entityId: taskId, perPage: 1 } }).then((r) => {
      const d = r.data;
      return d?.meta?.total ?? d?.data?.meta?.total ?? 0;
    }),
    staleTime: 2 * 60 * 1000,
  });
  const msgCount = typeof data === 'number' ? data : 0;

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={`Discussion${msgCount > 0 ? ` (${msgCount})` : ''}`}
        className={cn(
          'w-7 h-7 rounded-md flex items-center justify-center shrink-0 relative transition-colors',
          msgCount > 0 ? 'text-blue-600 hover:bg-blue-100' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50',
        )}
      >
        <MessageSquare className="w-3.5 h-3.5" />
        {msgCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[8px] font-bold text-white ring-1 ring-white">
            {msgCount > 9 ? '9+' : msgCount}
          </span>
        )}
      </button>
      <DiscussionDrawer
        open={open}
        onClose={() => setOpen(false)}
        entityType="task"
        entityId={taskId}
        title={taskName}
      />
    </>
  );
}

// ─── Inline Editable Cell ────────────────────────────────────────────────────

function InlineEditCell({ value, type = 'number', prefix, suffix, width, onSave }: {
  value: any; type?: 'number' | 'text'; prefix?: string; suffix?: string; width: string;
  onSave: (val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');

  const display = value != null && value !== '' && Number(value) !== 0
    ? `${prefix || ''}${type === 'number' ? Number(value).toLocaleString() : value}${suffix || ''}`
    : '-';

  if (editing) {
    return (
      <input
        type={type}
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={() => { setEditing(false); onSave(editVal); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') setEditing(false); }}
        className={cn('font-mono text-[11px] text-right bg-white border border-blue-400 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-300', width)}
        autoFocus
      />
    );
  }

  return (
    <span
      onClick={() => { setEditVal(value != null ? String(value) : ''); setEditing(true); }}
      className={cn('font-mono text-[11px] cursor-pointer hover:bg-blue-50 hover:text-blue-700 rounded px-1 py-0.5 text-right block truncate', width, value ? 'text-slate-700' : 'text-slate-300')}
      title="Click to edit"
    >
      {display}
    </span>
  );
}

// ─── Sortable Task Row ──────────────────────────────────────────────────────

const statusMap: Record<string, { bg: string; text: string; label: string }> = {
  not_started: { bg: 'bg-slate-100', text: 'text-slate-600', label: 'Not Started' },
  in_progress: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'In Progress' },
  in_review: { bg: 'bg-violet-100', text: 'text-violet-700', label: 'In Review' },
  completed: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Completed' },
  on_hold: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'On Hold' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', label: 'Cancelled' },
};

// ─── Bulk collapse / expand ──────────────────────────────────────────────────
//
// Lets the toolbar's "Collapse all / Expand all" button drive every
// collapsible card in the planning view (ZoneGroup, HierarchicalZoneGroup,
// ProjectRootDeliverableGroup) without prop-drilling.
//
// Contract:
//   • `desired` is the boolean we want every collapsible to flip to. When
//     null the context is idle (no signal from the toolbar yet).
//   • `version` is bumped every time the toolbar fires the signal — even
//     if `desired` is unchanged — so a card that was manually toggled
//     after the last bulk action still re-syncs on the next bulk click.
//   • Cards call `useBulkCollapseSync(setCollapsed)` and an effect on
//     `version` resets their local state to `desired`.
//
// Local per-card state is intentionally preserved: users can still
// expand/collapse individual cards after a bulk action.
const BulkCollapseContext = createContext<{ desired: boolean | null; version: number }>({
  desired: null,
  version: 0,
});

function useBulkCollapseSync(setCollapsed: (b: boolean) => void) {
  const { desired, version } = useContext(BulkCollapseContext);
  // Watching `version` (not `desired`) is intentional: see contract above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (desired != null) setCollapsed(desired);
  }, [version]);
}

// Column grid template shared between headers and data rows
// Grid template for one task row.
// Columns: drag · check · code · name · zone · deliverable · service ·
//          est-hrs · logged-hrs · amount · est-start · due · assignees ·
//          status · actions
//
// The Zone column is intentionally shown in every grouping mode — when
// grouping by Deliverable / Service / None the zone context would
// otherwise be lost. Tasks at the project root display "Project Root".
const TASK_GRID = 'grid grid-cols-[16px_16px_80px_1fr_110px_96px_80px_56px_64px_64px_96px_96px_96px_96px_84px] gap-x-2 items-center';

function SortableTaskRow({ task, idx, projectId, members, selectedTaskIds, onToggleTask, onUpdate, onDeleteTask }: {
  task: any; idx: number; projectId: number; members: any[];
  selectedTaskIds?: Set<number>; onToggleTask?: (id: number) => void;
  onUpdate: () => void; onDeleteTask: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition, marginLeft: 28 };
  const st = statusMap[task.status] || statusMap.not_started;
  const isSelected = selectedTaskIds?.has(task.id) ?? false;
  const serviceName = task.serviceType?.name || task.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || null;
  const serviceColor = task.serviceType?.color || '#3B82F6';
  const queryClient = useQueryClient();

  // Spreadsheet-style multi-edit: if this row is part of a multi-selection,
  // an inline edit propagates to ALL selected rows. If only one row is
  // selected (or none), it behaves like a normal single-task edit.
  const saveField = async (field: string, value: string) => {
    const payload: any = {};
    if (field === 'budgetHours') payload.budgetHours = value ? Number(value) : null;
    else if (field === 'budgetAmount') payload.budgetAmount = value ? Number(value) : null;
    else if (field === 'estimatedStartDate') payload.estimatedStartDate = value || null;
    else if (field === 'startDate') payload.startDate = value || null;
    else if (field === 'endDate') payload.endDate = value || null;
    // FK refs — empty string means "clear", otherwise expect a numeric id.
    else if (field === 'serviceTypeId') payload.serviceTypeId = value ? Number(value) : null;
    else if (field === 'phaseId') payload.phaseId = value ? Number(value) : null;
    else return;

    const isBulk = !!(selectedTaskIds && selectedTaskIds.has(task.id) && selectedTaskIds.size > 1);
    const targetIds = isBulk ? Array.from(selectedTaskIds!) : [task.id];

    try {
      if (isBulk) {
        const results = await Promise.allSettled(
          targetIds.map((id) => tasksApi.update(id, payload)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        if (ok > 0 && fail === 0) {
          notify.success(`Updated ${ok} task${ok !== 1 ? 's' : ''}`, { code: 'TASK-BULK-UPDATE-200' });
        } else if (ok > 0 && fail > 0) {
          notify.warning(`Updated ${ok}, ${fail} failed`, { code: 'TASK-BULK-UPDATE-207' });
        } else {
          notify.error('Bulk update failed', { code: 'TASK-BULK-UPDATE-500' });
        }
      } else {
        await tasksApi.update(task.id, payload);
      }
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    } catch (err: any) {
      notify.apiError(err, 'Failed to update task');
    }
  };

  // Estimated start (planning forecast) and Due date are exposed in the
  // grid. Actual `startDate` lives on the task drawer / detail page —
  // it's not part of the planning view.
  const estStartDate = task.estimatedStartDate ? task.estimatedStartDate.split('T')[0] : '';
  const dueDate = task.endDate ? task.endDate.split('T')[0] : '';
  const isOverdue = dueDate && new Date(dueDate) < new Date() && task.status !== 'completed' && task.status !== 'cancelled';

  // Zone color for left border
  const zoneType = task.zone?.zoneType || 'zone';
  const zoneBorderColors: Record<string, string> = {
    site: 'border-l-indigo-400', building: 'border-l-amber-500', level: 'border-l-teal-400',
    zone: 'border-l-amber-400', area: 'border-l-purple-400', floor: 'border-l-blue-400',
    section: 'border-l-teal-400', wing: 'border-l-pink-400',
  };

  return (
    // setNodeRef on the row's outer div (so dnd-kit can measure / transform
    // the whole row), but the drag attributes + listeners live on the
    // grip button below — that's the recommended shape and it makes the
    // a11y focus land on the actual drag handle.
    <div ref={setNodeRef} style={style} className={cn(
      TASK_GRID, 'py-1.5 px-4 border-b border-l-[3px] transition-colors text-[13px]',
      zoneBorderColors[zoneType] || 'border-l-slate-300',
      isDragging && 'opacity-40 bg-blue-50 shadow-lg z-10 border-blue-300',
      isOver && !isDragging && 'border-t-2 border-t-blue-500',
      isSelected ? 'bg-blue-50/60 border-slate-200' : idx % 2 === 0 ? 'bg-white border-slate-100' : 'bg-slate-50/50 border-slate-100',
      !isDragging && !isOver && 'hover:bg-blue-50/30',
    )}>
      {/* Drag handle. The hit area is the full grid cell (not just the icon)
          so users don't have to nail a 14×14 px target. `type="button"`
          stops form-submit from accidentally firing. */}
      <button
        type="button"
        aria-label="Drag to reorder task"
        title="Drag to reorder"
        {...listeners}
        {...attributes}
        className="-ml-2 flex h-7 w-7 items-center justify-center rounded cursor-grab active:cursor-grabbing text-slate-400 hover:text-blue-600 hover:bg-blue-50 shrink-0 touch-none focus:outline-none focus:ring-2 focus:ring-blue-300"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer" checked={isSelected} onChange={() => onToggleTask?.(task.id)} />
      <span className="font-mono text-[11px] font-medium text-slate-500 truncate" title={task.code || ''}>{task.code || '-'}</span>
      <span className="font-medium text-slate-900 min-w-0 truncate" title={task.name}>
        {task.name}
        {task.dependencies?.length > 0 && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] text-amber-600" title={`Depends on: ${task.dependencies.map((d: any) => d.dependsOn?.name || d.dependsOn?.code).join(', ')}`}>
            ⛓ {task.dependencies.length}
          </span>
        )}
      </span>
      {/* Zone context — kept visible in every grouping mode so the user
          doesn't lose the zone when grouping by Deliverable/Service/None.
          Tasks at the project root render as italic muted "Project Root";
          deeply nested tasks show the leaf zone with the full breadcrumb
          (e.g. "Building > Floor 1 > Unit A") on hover. */}
      <span className="text-[11px] truncate">
        {task.zoneId == null ? (
          <span className="italic text-slate-400">Project Root</span>
        ) : (
          <span
            className="text-slate-600"
            title={Array.isArray(task.zoneBreadcrumb) && task.zoneBreadcrumb.length > 0
              ? task.zoneBreadcrumb.join(' › ')
              : (task.zone?.name ?? '')}
          >
            {task.zone?.name || <span className="text-slate-300">-</span>}
          </span>
        )}
      </span>
      {/* Deliverable cell — click to edit. The picker pulls from
          /templates?type=task_list (the same list shown on
          /templates/deliverables); the underlying Task FK is still
          serviceTypeId (find-or-created from the template name on
          save). Falls back to the [SERVICE:xxx] description marker
          for legacy tasks that don't have a ServiceType FK yet. */}
      <CompactPickerCell
        projectId={projectId}
        currentId={task.serviceTypeId ?? null}
        currentLabel={task.serviceType?.name || task.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || null}
        currentColor={task.serviceType?.color}
        kind="deliverable"
        fieldLabel="Deliverable"
        onSave={(v) => saveField('serviceTypeId', v)}
      />
      {/* Service cell — click to edit. Phase is the parent Service. */}
      <CompactPickerCell
        projectId={projectId}
        currentId={task.phaseId ?? null}
        currentLabel={task.phase?.name ?? null}
        currentColor={task.phase?.color}
        kind="phase"
        fieldLabel="Service"
        onSave={(v) => saveField('phaseId', v)}
      />
      {/* Estimate (budgetHours) — editable. */}
      <InlineEditCell value={task.budgetHours} suffix="h" width="w-14" onSave={(v) => saveField('budgetHours', v)} />
      {/* Reported / logged hours — read-only sum of all TimeEntry.minutes
          for this task across the team. Aggregated server-side in
          planning.service.ts → loggedMinutes. Red if it has exceeded the
          budget estimate (budget > 0 and logged > budget). */}
      {(() => {
        const loggedHours = Number(task.loggedMinutes ?? 0) / 60;
        const budget = Number(task.budgetHours ?? 0);
        const overBudget = budget > 0 && loggedHours > budget;
        return (
          <span
            className={cn(
              'text-right text-[11px] font-mono tabular-nums',
              loggedHours === 0 ? 'text-slate-300' : overBudget ? 'text-red-600 font-semibold' : 'text-slate-700',
            )}
            title="Total hours reported by team members on this task"
          >
            {loggedHours > 0 ? `${loggedHours.toFixed(1)}h` : '—'}
          </span>
        );
      })()}
      <InlineEditCell value={task.budgetAmount} prefix="₪" width="w-16" onSave={(v) => saveField('budgetAmount', v)} />
      {/* Estimated start date — planning forecast (distinct from actual
          startDate, which is set when work begins and lives in the drawer). */}
      <span>
        <input
          type="date"
          value={estStartDate}
          onChange={(e) => saveField('estimatedStartDate', e.target.value)}
          className={cn(
            'w-full px-1 py-0.5 rounded border text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-400',
            'border-slate-200 text-slate-600 bg-transparent',
            !estStartDate && 'text-slate-300',
          )}
          title="Estimated (planned) start date"
        />
      </span>
      <span>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => saveField('endDate', e.target.value)}
          className={cn(
            'w-full px-1 py-0.5 rounded border text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-400',
            isOverdue ? 'border-red-300 text-red-600 bg-red-50' : 'border-slate-200 text-slate-600 bg-transparent',
            !dueDate && 'text-slate-300',
          )}
        />
      </span>
      <span className="flex items-center">
        <AssigneePicker task={task} members={members} projectId={projectId} onUpdate={onUpdate} selectedTaskIds={selectedTaskIds} />
      </span>
      <StatusBadgeDropdown taskId={task.id} currentStatus={task.status} projectId={projectId} selectedTaskIds={selectedTaskIds} />
      <div className="flex items-center gap-0.5">
        <TaskAttachmentButton taskId={task.id} projectId={projectId} />
        <TaskDiscussionButton taskId={task.id} taskName={task.name} />
        <button
          onClick={() => onDeleteTask(task.id)}
          title="Delete task"
          className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Sortable Task List (renders tasks as SortableContext — DndContext is at parent level) ───

function SortableTaskList({ tasks, zoneId, projectId, members, selectedTaskIds, onToggleTask, onUpdate, onDeleteTask }: {
  tasks: any[]; zoneId: number; projectId: number; members: any[];
  selectedTaskIds?: Set<number>; onToggleTask?: (id: number) => void;
  onUpdate: () => void; onDeleteTask: (id: number) => void;
}) {
  const taskIds = useMemo(() => tasks.map((t: any) => t.id), [tasks]);

  if (tasks.length === 0) return null;

  return (
    <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
      {tasks.map((task: any, idx: number) => (
        <SortableTaskRow
          key={task.id}
          task={task}
          idx={idx}
          projectId={projectId}
          members={members}
          selectedTaskIds={selectedTaskIds}
          onToggleTask={onToggleTask}
          onUpdate={onUpdate}
          onDeleteTask={onDeleteTask}
        />
      ))}
    </SortableContext>
  );
}

// ─── Catalog Picker for Zone — pick tasks from catalog and create in a zone ──

function CatalogPickerForZone({ zoneId, projectId, onClose, onDone }: {
  zoneId: number; projectId: number; onClose: () => void; onDone: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const { data: allTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });
  const catalogEntry = (allTemplates as any[]).find((t: any) => t.code === '__TASK_CATALOG__');
  const { data: catalog, isLoading } = useQuery({
    queryKey: ['templates', catalogEntry?.id],
    enabled: !!catalogEntry?.id,
    queryFn: () => client.get(`/templates/${catalogEntry.id}`).then((r) => r.data.data ?? r.data),
  });
  const catalogTasks: any[] = catalog?.templateTasks ?? [];
  const filtered = search.trim()
    ? catalogTasks.filter((t: any) => t.name?.toLowerCase().includes(search.toLowerCase()) || t.code?.toLowerCase().includes(search.toLowerCase()))
    : catalogTasks;

  const handleAdd = async () => {
    const tasks = catalogTasks.filter((t: any) => selected.has(t.id));
    if (tasks.length === 0) return;
    setAdding(true);
    try {
      for (const t of tasks) {
        await tasksApi.create({
          zoneId,
          code: t.code,
          name: t.name,
          description: t.description,
          budgetHours: t.defaultBudgetHours ? Number(t.defaultBudgetHours) : undefined,
          budgetAmount: t.defaultBudgetAmount ? Number(t.defaultBudgetAmount) : undefined,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      notify.success(`Added ${tasks.length} task${tasks.length !== 1 ? 's' : ''} from catalog`, { code: 'TASK-ADD-200' });
      onDone();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add tasks');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-[14px] border border-slate-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold">Add Tasks from Catalog</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="border-b border-slate-200 px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks..." className="w-full pl-9 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? <p className="py-8 text-center text-sm text-slate-400">Loading catalog...</p> : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">{search ? 'No tasks match.' : 'No tasks in catalog.'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 bg-slate-50 text-xs">
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2 text-left font-medium">Code</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
              </tr></thead>
              <tbody>
                {filtered.map((t: any) => (
                  <tr key={t.id} className={cn('border-b border-slate-50 cursor-pointer', selected.has(t.id) ? 'bg-blue-50' : 'hover:bg-slate-50')} onClick={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }}>
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(t.id)} onChange={() => {}} className="h-3.5 w-3.5" /></td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{t.code || '-'}</td>
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetHours ? Number(t.defaultBudgetHours) : '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetAmount ? Number(t.defaultBudgetAmount).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
          <span className="text-xs text-slate-400">{filtered.length} tasks</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:border-slate-400">Cancel</button>
            <button onClick={handleAdd} disabled={selected.size === 0 || adding} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {adding ? 'Adding...' : `Add ${selected.size} Task${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Deliverable Template Picker (applies a task_list template's tasks to a zone) ─

function PhaseTemplatePickerForZone({ zoneId, projectId, onClose, onDone }: {
  zoneId: number; projectId: number; onClose: () => void; onDone: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const { data: allTemplates = [], isLoading } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });
  const templates = (Array.isArray(allTemplates) ? allTemplates : []).filter((t: any) => t.code !== '__TASK_CATALOG__');
  const filtered = search.trim()
    ? templates.filter((t: any) => t.name?.toLowerCase().includes(search.toLowerCase()) || t.code?.toLowerCase().includes(search.toLowerCase()))
    : templates;

  const handleAdd = async () => {
    const toAdd = templates.filter((t: any) => selected.has(t.id));
    if (toAdd.length === 0) return;
    setAdding(true);
    try {
      for (const tpl of toAdd) {
        const detail = await client.get(`/templates/${tpl.id}`).then((r) => r.data.data ?? r.data);
        for (const task of (detail?.templateTasks ?? [])) {
          await tasksApi.create({
            zoneId,
            code: task.code,
            name: task.name,
            description: `[SERVICE:${tpl.name}]`,
            budgetHours: task.defaultBudgetHours ? Number(task.defaultBudgetHours) : undefined,
            budgetAmount: task.defaultBudgetAmount ? Number(task.defaultBudgetAmount) : undefined,
          });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      notify.success(`Added ${toAdd.length} deliverable template${toAdd.length !== 1 ? 's' : ''}`, { code: 'TPL-APPLY-200' });
      onDone();
    } catch (err: any) {
      notify.apiError(err, 'Failed to apply template');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-[14px] border border-slate-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold">Select Deliverable Templates</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="border-b border-slate-200 px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..." className="w-full pl-9 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? <p className="py-8 text-center text-sm text-slate-400">Loading...</p> : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">{search ? 'No templates match.' : 'No deliverable templates available.'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 bg-slate-50 text-xs">
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Service</th>
                <th className="px-3 py-2 text-right font-medium">Tasks</th>
              </tr></thead>
              <tbody>
                {filtered.map((t: any) => (
                  <tr key={t.id} className={cn('border-b border-slate-50 cursor-pointer', selected.has(t.id) ? 'bg-blue-50' : 'hover:bg-slate-50')} onClick={() => { const n = new Set(selected); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSelected(n); }}>
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(t.id)} onChange={() => {}} className="h-3.5 w-3.5" /></td>
                    <td className="px-3 py-2 font-medium">{t.name}</td>
                    <td className="px-3 py-2">{t.phase ? <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700">{t.phase.name}</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-right">{t._count?.templateTasks ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
          <span className="text-xs text-slate-400">{filtered.length} templates</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg hover:border-slate-400">Cancel</button>
            <button onClick={handleAdd} disabled={selected.size === 0 || adding} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {adding ? 'Adding...' : `Apply ${selected.size} Template${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Bulk Action Bar — floating bar for operating on selected tasks ─────────

function BulkActionBar({
  selectedCount,
  selectedTaskIds,
  members,
  projectId,
  onClear,
  onRequestDelete,
}: {
  selectedCount: number;
  selectedTaskIds: Set<number>;
  members: any[];
  projectId: number;
  onClear: () => void;
  /** Open the styled confirm modal for the given task ids. The bar
   *  itself doesn't run the delete — the parent owns the modal so the
   *  confirm UX matches single-row deletes. */
  onRequestDelete: (ids: number[]) => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const assignRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const priorityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!assignOpen && !statusOpen && !priorityOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (assignOpen && assignRef.current && !assignRef.current.contains(e.target as Node)) {
        setAssignOpen(false);
      }
      if (statusOpen && statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
      if (priorityOpen && priorityRef.current && !priorityRef.current.contains(e.target as Node)) {
        setPriorityOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [assignOpen, statusOpen, priorityOpen]);

  const filteredMembers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return members.filter((m: any) => {
      if (!q) return true;
      const u = m.user ?? m;
      const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return full.includes(q);
    });
  }, [members, search]);

  const handleBulkAssign = async (userId: number) => {
    if (busy || selectedTaskIds.size === 0) return;
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    // Parallel assignments — ignore conflicts (user already assigned to a task)
    const results = await Promise.allSettled(
      taskIds.map((taskId) => tasksApi.addAssignee(taskId, { userId })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const alreadyAssigned = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.response?.status === 409,
    ).length;
    const failed = results.length - succeeded - alreadyAssigned;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);
    setAssignOpen(false);
    setSearch('');

    const user = members.find((m: any) => (m.user?.id ?? m.id) === userId);
    const u = user?.user ?? user ?? {};
    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'user';

    if (succeeded > 0 && failed === 0 && alreadyAssigned === 0) {
      notify.success(`Assigned ${name} to ${succeeded} task${succeeded !== 1 ? 's' : ''}`, {
        code: 'TASK-ASSIGN-200',
      });
    } else if (succeeded > 0 && alreadyAssigned > 0 && failed === 0) {
      notify.success(
        `Assigned ${name} to ${succeeded} task${succeeded !== 1 ? 's' : ''} (${alreadyAssigned} already assigned)`,
        { code: 'TASK-ASSIGN-200' },
      );
    } else if (failed > 0 && succeeded > 0) {
      notify.warning(`Assigned to ${succeeded}, ${failed} failed`, { code: 'TASK-ASSIGN-207' });
    } else if (succeeded === 0 && alreadyAssigned > 0 && failed === 0) {
      notify.info(`${name} is already assigned to all selected tasks`);
    } else {
      notify.error(`Could not assign ${name}`, { code: 'TASK-ASSIGN-500' });
    }
    onClear();
  };

  const handleBulkStatus = async (status: string) => {
    if (busy || selectedTaskIds.size === 0) return;
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    const results = await Promise.allSettled(
      taskIds.map((taskId) => tasksApi.update(taskId, { status })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);
    setStatusOpen(false);

    if (succeeded > 0 && failed === 0) {
      notify.success(`Updated status on ${succeeded} task${succeeded !== 1 ? 's' : ''}`, {
        code: 'TASK-UPDATE-200',
      });
    } else if (succeeded > 0 && failed > 0) {
      notify.warning(`Updated ${succeeded}, ${failed} failed`, { code: 'TASK-UPDATE-207' });
    } else {
      notify.error(`Could not update status`, { code: 'TASK-UPDATE-500' });
    }
    onClear();
  };

  // Set priority on every selected task. Same parallel-update + summary
  // pattern as handleBulkStatus.
  const handleBulkPriority = async (priority: string) => {
    if (busy || selectedTaskIds.size === 0) return;
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    const results = await Promise.allSettled(
      taskIds.map((taskId) => tasksApi.update(taskId, { priority })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);
    setPriorityOpen(false);

    if (succeeded > 0 && failed === 0) {
      notify.success(`Set priority on ${succeeded} task${succeeded !== 1 ? 's' : ''}`, { code: 'TASK-UPDATE-200' });
    } else if (succeeded > 0 && failed > 0) {
      notify.warning(`Updated ${succeeded}, ${failed} failed`, { code: 'TASK-UPDATE-207' });
    } else {
      notify.error(`Could not set priority`, { code: 'TASK-UPDATE-500' });
    }
    onClear();
  };

  // Delete every selected task. Confirms first because this is destructive
  // and not undoable from the planning view.
  const handleBulkDelete = async () => {
    if (busy || selectedTaskIds.size === 0) return;
    if (!confirm(`Delete ${selectedTaskIds.size} task${selectedTaskIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    const taskIds = Array.from(selectedTaskIds);
    const results = await Promise.allSettled(taskIds.map((id) => tasksApi.delete(id)));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
    setBusy(false);

    if (succeeded > 0 && failed === 0) {
      notify.success(`Deleted ${succeeded} task${succeeded !== 1 ? 's' : ''}`, { code: 'TASK-DELETE-200' });
    } else if (succeeded > 0 && failed > 0) {
      notify.warning(`Deleted ${succeeded}, ${failed} failed`, { code: 'TASK-DELETE-207' });
    } else {
      notify.error(`Could not delete`, { code: 'TASK-DELETE-500' });
    }
    onClear();
  };

  if (selectedCount === 0) return null;

  const statusOptions = [
    { value: 'not_started', label: 'Not Started', dot: 'bg-slate-400' },
    { value: 'in_progress', label: 'In Progress', dot: 'bg-blue-500' },
    { value: 'in_review', label: 'In Review', dot: 'bg-violet-500' },
    { value: 'completed', label: 'Completed', dot: 'bg-emerald-500' },
    { value: 'on_hold', label: 'On Hold', dot: 'bg-amber-500' },
    { value: 'cancelled', label: 'Cancelled', dot: 'bg-red-500' },
  ];

  const priorityOptions = [
    { value: 'low',      label: 'Low',      dot: 'bg-slate-400' },
    { value: 'medium',   label: 'Medium',   dot: 'bg-blue-500' },
    { value: 'high',     label: 'High',     dot: 'bg-amber-500' },
    { value: 'critical', label: 'Critical', dot: 'bg-red-500' },
  ];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
      <div className="flex items-center gap-3 rounded-[14px] border border-slate-200 bg-white px-4 py-3 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">
            {selectedCount}
          </span>
          <span className="text-sm font-semibold text-slate-700">
            task{selectedCount !== 1 ? 's' : ''} selected
            {selectedCount > 1 && (
              <span className="ml-2 text-[11px] font-normal text-slate-500">
                — edits to any selected row apply to all
              </span>
            )}
          </span>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        {/* Bulk Delete — triggers the styled confirm modal owned by the
            parent. Selection is cleared inside the modal's execute()
            after a successful delete. */}
        <button
          type="button"
          onClick={() => onRequestDelete(Array.from(selectedTaskIds))}
          disabled={busy || selectedCount === 0}
          className="flex items-center gap-1 rounded-md bg-red-50 hover:bg-red-100 text-red-600 text-[13px] font-semibold px-3 py-1.5 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="text-[13px] font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          Clear
        </button>
      </div>
    </div>
  );
}


// ─── Assignee Picker — multi-select, add/remove assignees on a task ──────────

function AssigneePicker({
  task,
  members,
  projectId,
  onUpdate,
  selectedTaskIds,
}: {
  task: any;
  members: any[];
  projectId: number;
  onUpdate: () => void;
  selectedTaskIds?: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);

  const assignees: any[] = task.assignees ?? [];
  const assignedUserIds = new Set(
    assignees.map((a: any) => a.user?.id ?? a.userId).filter((id: any) => typeof id === 'number'),
  );

  // Spreadsheet-style multi-edit: if this row is part of a multi-selection,
  // assign/unassign propagates across all selected rows.
  const isBulk = !!(selectedTaskIds && selectedTaskIds.has(task.id) && selectedTaskIds.size > 1);
  const targetIds = isBulk ? Array.from(selectedTaskIds!) : [task.id];

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  const summarize = (results: PromiseSettledResult<unknown>[], verb: string) => {
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // 409 = already assigned / already removed — count as "skipped", not failed.
    const skipped = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.response?.status === 409,
    ).length;
    const fail = results.length - ok - skipped;
    if (ok > 0 && fail === 0 && skipped === 0) {
      notify.success(`${verb} ${ok} task${ok !== 1 ? 's' : ''}`, { code: 'TASK-BULK-ASSIGN-200' });
    } else if (ok > 0 && skipped > 0 && fail === 0) {
      notify.success(`${verb} ${ok}, ${skipped} unchanged`, { code: 'TASK-BULK-ASSIGN-200' });
    } else if (ok > 0 && fail > 0) {
      notify.warning(`${verb} ${ok}, ${fail} failed`, { code: 'TASK-BULK-ASSIGN-207' });
    } else if (ok === 0 && skipped > 0 && fail === 0) {
      notify.info('No change — already in that state');
    } else if (fail > 0) {
      notify.error(`${verb}: all failed`, { code: 'TASK-BULK-ASSIGN-500' });
    }
  };

  const addOne = async (userId: number) => {
    if (busy) return;
    if (!isBulk && assignedUserIds.has(userId)) return;
    setBusy(true);
    try {
      if (isBulk) {
        const results = await Promise.allSettled(
          targetIds.map((id) => tasksApi.addAssignee(id, { userId })),
        );
        summarize(results, 'Assigned to');
      } else {
        await tasksApi.addAssignee(task.id, { userId });
      }
      invalidate();
      onUpdate();
      // Auto-close the picker 3s after a successful add — gives the user
      // time to spot the new chip but doesn't leave the dropdown floating
      // over the grid. Manual close (click-outside / × button) still works.
      window.setTimeout(() => setOpen(false), 3000);
    } catch (err: any) {
      notify.apiError(err, 'Failed to assign');
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (userId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      if (isBulk) {
        const results = await Promise.allSettled(
          targetIds.map((id) => tasksApi.removeAssignee(id, userId)),
        );
        summarize(results, 'Unassigned from');
      } else {
        await tasksApi.removeAssignee(task.id, userId);
      }
      invalidate();
      onUpdate();
    } catch (err: any) {
      notify.apiError(err, 'Failed to unassign');
    } finally {
      setBusy(false);
    }
  };

  // Filter available members — exclude ones already assigned
  const available = members.filter((m: any) => {
    const uid = m.user?.id ?? m.id;
    return typeof uid === 'number' && !assignedUserIds.has(uid);
  });

  return (
    <div ref={ref} className="relative inline-flex items-center gap-1">
      {/* Stacked avatars of current assignees */}
      {assignees.length > 0 && (
        <div className="flex -space-x-1.5">
          {assignees.slice(0, 3).map((a: any) => {
            const u = a.user ?? {};
            return (
              <button
                key={a.id ?? u.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); removeOne(u.id); }}
                title={`Remove ${u.firstName ?? ''} ${u.lastName ?? ''}`}
                className="relative w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center ring-2 ring-white hover:bg-red-100 hover:text-red-600 group/avatar"
              >
                {(u.firstName?.[0] ?? '') + (u.lastName?.[0] ?? '')}
                <X className="absolute inset-0 m-auto h-2.5 w-2.5 opacity-0 group-hover/avatar:opacity-100" />
              </button>
            );
          })}
          {assignees.length > 3 && (
            <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-semibold flex items-center justify-center ring-2 ring-white">
              +{assignees.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Add button (only if there are available members) */}
      {available.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="w-5 h-5 rounded-full border border-dashed border-slate-300 text-slate-400 flex items-center justify-center hover:border-blue-500 hover:text-blue-600"
          title="Assign people"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-52 rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="px-3 py-2 border-b border-slate-100 text-[11px] font-semibold text-slate-500">
            Assign People
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {available.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400">
                {members.length === 0 ? 'No project members' : 'Everyone is already assigned'}
              </p>
            ) : (
              available.map((m: any) => {
                const u = m.user ?? m;
                const uid = u.id;
                const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown';
                return (
                  <button
                    key={uid}
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); addOne(uid); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                      {(u.firstName?.[0] ?? '') + (u.lastName?.[0] ?? '')}
                    </span>
                    <span className="truncate text-slate-700">{name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Template Picker Dialog ──────────────────────────────────────────────────

function TemplatePickerDialog({ projectId, onClose, onApplied }: { projectId: number; onClose: () => void; onApplied: () => void }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [zoneName, setZoneName] = useState('');
  const [sortBy, setSortBy] = useState('usage');

  const { data: raw = [] } = useQuery({
    queryKey: ['templates', 'zone'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=zone').then((r) => r.data.data ?? r.data),
  });

  const templates = useMemo(() => {
    let list = Array.isArray(raw) ? raw : [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((t: any) => t.name?.toLowerCase().includes(q) || t.code?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q));
    }
    if (sortBy === 'usage') list.sort((a: any, b: any) => (b.usageCount ?? 0) - (a.usageCount ?? 0));
    else if (sortBy === 'name') list.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    return list;
  }, [raw, search, sortBy]);

  const selected = templates.find((t: any) => t.id === selectedId);

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !zoneName.trim()) return;
      // Apply template with the user's zone name directly (no post-rename needed)
      await client.post('/zones/apply-project-template', {
        projectId,
        templateId: selected.id,
        zoneName: zoneName.trim(),
      });
    },
    onSuccess: () => {
      notify.success('Zone added from template', { code: 'TPL-APPLY-200' });
      onApplied();
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to apply template'),
  });

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Zone from Template</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Zone name — ALWAYS visible at top */}
      <div className="px-5 py-4 border-b border-slate-100 bg-blue-50/20">
        <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Name for This Project *</label>
        <div className="flex items-center gap-3">
          <input value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="e.g. Tower A - Ground Floor"
            className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
          {selected && (
            <button onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending || !zoneName.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 whitespace-nowrap">
              {applyMutation.isPending ? 'Adding...' : 'Add to Project'}
            </button>
          )}
        </div>
        {selected && <p className="text-[11px] text-slate-400 mt-1.5">Selected: <strong className="text-slate-700">{selected.name}</strong> — {selected._count?.templateTasks ?? 0} tasks will be created</p>}
        {!selected && <p className="text-[11px] text-slate-400 mt-1.5">Enter a name, then select a template below</p>}
      </div>

      {/* Search + Sort */}
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..." className="w-full pl-9 px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" autoFocus />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
          <option value="usage">Most Used</option>
          <option value="name">Name A-Z</option>
        </select>
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[300px] overflow-y-auto">
        {templates.map((t: any) => {
          const isSelected = t.id === selectedId;
          const svcCount = new Set((t.templateTasks ?? []).map((tk: any) => tk.description?.match(/^\[SERVICE:(.+)\]$/)?.[1]).filter(Boolean)).size;
          return (
            <div key={t.id} onClick={() => { setSelectedId(isSelected ? null : t.id); if (!isSelected) setZoneName(t.name); }}
              className={cn('rounded-[14px] p-4 cursor-pointer transition-all duration-150',
                isSelected ? 'border-2 border-blue-500 bg-blue-50/40 shadow-sm' : 'border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30')}>
              <div className="flex items-center gap-2 mb-2">
                <h4 className={cn('text-[13px] font-semibold flex-1', isSelected ? 'text-blue-700' : 'text-slate-900')}>{t.name}</h4>
                {isSelected && <span className="rounded-[5px] bg-blue-600 text-white text-[11px] font-bold px-2 py-0.5">Selected</span>}
              </div>
              {t.description && <p className={cn('text-[12px] mb-2 line-clamp-2', isSelected ? 'text-blue-600/70' : 'text-slate-500')}>{t.description}</p>}
              <div className={cn('text-[11px] font-medium', isSelected ? 'text-blue-400' : 'text-slate-400')}>
                {t._count?.templateZones ?? 0} zones · {svcCount} services · {t._count?.templateTasks ?? 0} tasks · Used {t.usageCount ?? 0}x
              </div>
            </div>
          );
        })}
        {templates.length === 0 && <p className="col-span-3 py-8 text-center text-[13px] text-slate-400">No zone templates available.</p>}
      </div>
    </div>
  );
}

// ─── Add Zone Manually Dialog ────────────────────────────────────────────────

function AddZoneManuallyDialog({ projectId, onClose, onCreated }: { projectId: number; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [zoneType, setZoneType] = useState('zone');
  const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'];

  const createZone = useMutation({
    mutationFn: () => zonesApi.create({ projectId, name: name.trim(), zoneType }),
    onSuccess: () => { notify.success('Zone created', { code: 'ZONE-CREATE-200' }); onCreated(); onClose(); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Zone Manually</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tower A - Ground Floor" autoFocus
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
        </div>
        <div>
          <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Zone Type</label>
          <select value={zoneType} onChange={(e) => setZoneType(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none">
            {ZONE_TYPES.map(zt => <option key={zt} value={zt}>{zt.charAt(0).toUpperCase() + zt.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
        <button onClick={() => createZone.mutate()} disabled={createZone.isPending || !name.trim()} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
          {createZone.isPending ? 'Creating...' : 'Create Zone'}
        </button>
      </div>
    </div>
  );
}

// ─── Add Root Task Dialog (project-root, no zone) ────────────────────────────
//
// Same shape as the inline "Add Task" inside a zone, but creates the task
// with zoneId=null so it lives at the project root. The planning grid
// renders these in a dedicated "Project Root" section above the zones.

// Project-scoped picker for one of {ServiceType, Phase}. Shows the
// distinct entries already in use by this project's tasks, plus a
// "+ Create new" inline form. Picking from the dropdown sets the value;
// picking "Create new" opens an inline name+color row that POSTs to the
// matching endpoint and then auto-selects the freshly-created entry.
function ProjectScopedPicker({
  value,
  onChange,
  projectTasks,
  fieldKey,
  label,
  endpoint,
  placeholder,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** All tasks in this project — used to extract the project-scoped
   *  subset of the global catalog. */
  projectTasks: any[];
  /** 'serviceType' or 'phase' — drives which task field we read. */
  fieldKey: 'serviceType' | 'phase';
  label: string;
  /** API path to GET (full list) and POST (create new) against. */
  endpoint: '/service-types' | '/phases';
  placeholder: string;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#8B5CF6');
  const [busy, setBusy] = useState(false);

  // Load the global catalog so we have id/name/color for everything,
  // then narrow to the IDs that already appear on tasks in this project.
  const { data: all = [] } = useQuery({
    queryKey: [endpoint],
    queryFn: () => client.get(endpoint).then((r) => r.data?.data ?? r.data),
    staleTime: 60_000,
  });
  const list: any[] = Array.isArray(all) ? all : [];

  // Project-scoped: only entries referenced by this project's tasks.
  // Falls back to the global list if the project has no tasks yet (so
  // the picker isn't empty on a brand-new project).
  const usedIds = new Set<number>();
  for (const t of projectTasks) {
    const id: number | undefined = t[fieldKey]?.id ?? t[`${fieldKey}Id`];
    if (typeof id === 'number') usedIds.add(id);
  }
  const scoped = usedIds.size > 0 ? list.filter((x: any) => usedIds.has(x.id)) : list;

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const resp = await client.post(endpoint, { name, color: newColor });
      const created = resp.data?.data ?? resp.data;
      // Refresh the cached catalog so the new entry shows in dropdowns
      // everywhere — and so subsequent renders pick it up.
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      if (created?.id) onChange(created.id);
      setCreating(false);
      setNewName('');
      setNewColor('#8B5CF6');
    } catch (err: any) {
      notify.apiError(err, `Failed to create ${label.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{label}</label>
      {!creating ? (
        <div className="flex items-center gap-1.5">
          <select
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] focus:border-blue-500 focus:outline-none"
          >
            <option value="">{placeholder}</option>
            {scoped.map((x: any) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 whitespace-nowrap"
          >
            + Create new
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`New ${label} name`}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) create(); if (e.key === 'Escape') setCreating(false); }}
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] focus:border-blue-500 focus:outline-none"
          />
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="w-9 h-8 rounded border border-slate-200 cursor-pointer p-0"
            title="Color"
          />
          <button
            type="button"
            onClick={create}
            disabled={busy || !newName.trim()}
            className="text-[12px] font-semibold bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setCreating(false); setNewName(''); }}
            className="text-[12px] text-slate-400 hover:text-slate-600 px-1"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// Compact inline picker for the task grid's Deliverable + Service cells.
// Default: shows the current label as a coloured pill (or em-dash if
// unset). Click → swaps to a native <select> with the option list plus
// a "__new__" sentinel that prompts for a name and creates a new
// catalog entry. Closes on save.
//
// Two modes:
//   • kind='phase'       — Service picker. Source: /phases. Save:
//                          phaseId is the option id directly.
//   • kind='deliverable' — Deliverable picker. Source:
//                          /templates?type=task_list (the same list
//                          shown on /templates/deliverables, minus
//                          __TASK_CATALOG__). Each Deliverable is a
//                          Template, but Task only stores serviceTypeId,
//                          so on save we find-or-create a ServiceType
//                          named after the chosen Template and save
//                          its id. This way the picker matches the
//                          user's deliverable catalog while the
//                          underlying Task FK stays consistent with
//                          existing data.
function CompactPickerCell({
  projectId,
  currentId,
  currentLabel,
  currentColor,
  kind,
  fieldLabel,
  onSave,
}: {
  projectId: number;
  currentId: number | null | undefined;
  currentLabel: string | null | undefined;
  currentColor?: string | null;
  kind: 'phase' | 'deliverable';
  fieldLabel: string;
  /** Called with the new id (string) — '' means clear. The id semantics
   *  differ by kind: for 'phase' it's the phaseId; for 'deliverable'
   *  it's the resolved serviceTypeId (after find-or-create). */
  onSave: (newIdStr: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  // Source endpoint depends on kind. For deliverable we hit /templates
  // and filter the synthetic __TASK_CATALOG__ entry the templates
  // controller adds; for phase we hit /phases directly.
  const sourceUrl = kind === 'deliverable' ? '/templates?type=task_list' : '/phases';
  const { data: all = [] } = useQuery({
    queryKey: [sourceUrl],
    queryFn: () => client.get(sourceUrl).then((r) => r.data?.data ?? r.data),
    staleTime: 60_000,
    enabled: editing, // only fetch when the user actually opens the picker
  });
  const fullList: any[] = (Array.isArray(all) ? all : [])
    .filter((x: any) => kind !== 'deliverable' || x.code !== '__TASK_CATALOG__');

  // Project-scoping: for the Service picker we narrow to phases used by
  // tasks in this project. For Deliverable we show the full template
  // catalog — the user explicitly asked for this list to match the
  // /templates/deliverables page (which doesn't filter by project).
  const planningCache: any = queryClient.getQueryData(['planning', projectId]);
  const projectTasks: any[] = planningCache?.tasks ?? planningCache?.data?.tasks ?? [];
  let list: any[];
  if (kind === 'deliverable') {
    list = fullList;
  } else {
    const usedIds = new Set<number>();
    for (const t of projectTasks) {
      const id: number | undefined = t.phase?.id ?? t.phaseId;
      if (typeof id === 'number') usedIds.add(id);
    }
    if (typeof currentId === 'number') usedIds.add(currentId);
    const scoped = fullList.filter((x: any) => usedIds.has(x.id));
    list = scoped.length > 0 ? scoped : fullList;
  }

  // For the Deliverable mode the cell stores serviceTypeId on the Task.
  // The dropdown <option value> is the Template id, so we need a way to
  // pre-select the option matching the task's current ServiceType. We
  // do that by name (Template.name == ServiceType.name when the ST was
  // find-or-created from the template).
  const selectedTemplateValue = (() => {
    if (kind !== 'deliverable') return currentId ?? '';
    if (!currentLabel) return '';
    const match = fullList.find((t: any) => t.name === currentLabel);
    return match ? String(match.id) : '';
  })();

  // Resolve a Template (by id) to a ServiceType id, creating the ST if
  // necessary. Used by the Deliverable mode's save handler.
  const resolveServiceTypeIdForTemplate = async (template: any): Promise<number | null> => {
    const stListResp = await client.get('/service-types');
    const stList: any[] = stListResp.data?.data ?? stListResp.data ?? [];
    const existing = (Array.isArray(stList) ? stList : []).find(
      (s: any) => s.name === template.name,
    );
    if (existing) return existing.id;
    const createResp = await client.post('/service-types', {
      name: template.name,
      color: template.phase?.color ?? null,
    });
    const created = createResp.data?.data ?? createResp.data;
    queryClient.invalidateQueries({ queryKey: ['/service-types'] });
    return created?.id ?? null;
  };

  const handleChange = async (raw: string) => {
    if (raw === '__new__') {
      const name = window.prompt(`New ${fieldLabel} name:`);
      if (!name || !name.trim()) { setEditing(false); return; }
      setBusy(true);
      try {
        if (kind === 'deliverable') {
          // Create the deliverable as a Template (type=task_list) so it
          // shows up on /templates/deliverables alongside the others,
          // then find-or-create a matching ServiceType for the FK.
          const tplResp = await client.post('/templates', {
            name: name.trim(),
            type: 'task_list',
            code: `D-${Date.now().toString(36).toUpperCase()}`,
          });
          const tpl = tplResp.data?.data ?? tplResp.data;
          queryClient.invalidateQueries({ queryKey: [sourceUrl] });
          const stId = await resolveServiceTypeIdForTemplate(tpl);
          if (stId != null) await onSave(String(stId));
        } else {
          // Phase — single POST.
          const resp = await client.post('/phases', { name: name.trim() });
          const created = resp.data?.data ?? resp.data;
          queryClient.invalidateQueries({ queryKey: [sourceUrl] });
          if (created?.id) await onSave(String(created.id));
        }
      } catch (err: any) {
        notify.apiError(err, `Failed to create ${fieldLabel.toLowerCase()}`);
      } finally {
        setBusy(false);
        setEditing(false);
      }
      return;
    }

    setBusy(true);
    try {
      if (kind === 'deliverable' && raw) {
        // raw is a Template id — resolve to a ServiceType id then save.
        const tpl = fullList.find((t: any) => String(t.id) === raw);
        if (!tpl) { setEditing(false); return; }
        const stId = await resolveServiceTypeIdForTemplate(tpl);
        await onSave(stId != null ? String(stId) : '');
      } else {
        await onSave(raw);
      }
    } catch (err: any) {
      notify.apiError(err, `Failed to set ${fieldLabel.toLowerCase()}`);
    } finally {
      setBusy(false);
      setEditing(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={`Click to edit ${fieldLabel}`}
        className="text-left max-w-full truncate hover:bg-blue-50/50 rounded px-1 -mx-1 py-0.5"
      >
        {currentLabel ? (
          <span
            className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold inline-block truncate max-w-full"
            style={{
              backgroundColor: currentColor ? `${currentColor}15` : '#3B82F615',
              color: currentColor || '#3B82F6',
            }}
          >
            {currentLabel}
          </span>
        ) : (
          <span className="text-slate-300 text-[11px]">-</span>
        )}
      </button>
    );
  }

  return (
    <select
      autoFocus
      disabled={busy}
      value={selectedTemplateValue}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => setEditing(false)}
      onClick={(e) => e.stopPropagation()}
      className="w-full px-1 py-0.5 rounded border border-blue-300 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
    >
      <option value="">— None —</option>
      {list.map((x: any) => (
        <option key={x.id} value={x.id}>{x.name}</option>
      ))}
      <option value="__new__">+ Create new…</option>
    </select>
  );
}

function AddRootTaskDialog({ projectId, projectTasks, onClose, onCreated }: { projectId: number; projectTasks: any[]; onClose: () => void; onCreated: () => void }) {
  // Two flows:
  //   • manual:  one-off task — user types code/name/hours/amount.
  //   • catalog: pick from the existing task catalog (templates with
  //              code='__TASK_CATALOG__'). Multiple tasks can be added
  //              at once. Same data shape as the zone-side
  //              CatalogPickerForZone, just without a zoneId so they
  //              land at the project root.
  const [mode, setMode] = useState<'manual' | 'catalog'>('manual');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('');
  // Deliverable (= ServiceType) and Service (= Phase) for the new task.
  // Both are project-scoped pickers — the user sees what's already in
  // play in this project plus a "Create new" inline. Nullable means the
  // task is created without that label.
  const [serviceTypeId, setServiceTypeId] = useState<number | null>(null);
  const [phaseId, setPhaseId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);

  // Catalog data (only fetched when the user switches to the catalog tab).
  const { data: allTemplates = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data?.data ?? r.data),
    enabled: mode === 'catalog',
  });
  const catalogEntry = (allTemplates as any[]).find((t: any) => t.code === '__TASK_CATALOG__');
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['templates', catalogEntry?.id],
    enabled: mode === 'catalog' && !!catalogEntry?.id,
    queryFn: () => client.get(`/templates/${catalogEntry.id}`).then((r) => r.data?.data ?? r.data),
  });
  const catalogTasks: any[] = catalog?.templateTasks ?? [];
  const filtered = search.trim()
    ? catalogTasks.filter((t: any) =>
        t.name?.toLowerCase().includes(search.toLowerCase())
        || t.code?.toLowerCase().includes(search.toLowerCase()))
    : catalogTasks;

  const createTask = useMutation({
    mutationFn: () => tasksApi.create({
      // No zoneId — the API treats this as a root-level task and
      // stores zone_id = NULL.
      projectId,
      code: code.trim(),
      name: name.trim(),
      budgetHours: budgetHours ? Number(budgetHours) : undefined,
      budgetAmount: budgetAmount ? Number(budgetAmount) : undefined,
      serviceTypeId: serviceTypeId ?? undefined,
      phaseId: phaseId ?? undefined,
    } as any),
    onSuccess: () => { notify.success('Task created', { code: 'TASK-CREATE-200' }); onCreated(); onClose(); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const addFromCatalog = async () => {
    const tasks = catalogTasks.filter((t: any) => selected.has(t.id));
    if (tasks.length === 0) return;
    setAdding(true);
    try {
      const results = await Promise.allSettled(
        tasks.map((t: any) => tasksApi.create({
          projectId,
          code: t.code,
          name: t.name,
          description: t.description,
          budgetHours: t.defaultBudgetHours ? Number(t.defaultBudgetHours) : undefined,
          budgetAmount: t.defaultBudgetAmount ? Number(t.defaultBudgetAmount) : undefined,
          // Carry over the catalog's task-level service / phase if any —
          // this keeps the deliverable badge consistent with the zone
          // catalog flow.
          serviceTypeId: t.serviceTypeId ?? undefined,
          phaseId: t.phaseId ?? undefined,
        } as any)),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (fail === 0) notify.success(`Added ${ok} task${ok !== 1 ? 's' : ''} from catalog`, { code: 'TASK-ADD-200' });
      else if (ok > 0) notify.warning(`Added ${ok}, ${fail} failed`, { code: 'TASK-ADD-207' });
      else notify.error('Failed to add tasks', { code: 'TASK-ADD-500' });
      onCreated();
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to add tasks');
    } finally {
      setAdding(false);
    }
  };

  const toggleSelected = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Task at Project Root</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
      </div>

      {/* Mode tabs */}
      <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 w-fit">
        <button
          onClick={() => setMode('manual')}
          className={cn(
            'px-3 py-1 rounded-md text-[12px] font-semibold transition-colors',
            mode === 'manual' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Manual
        </button>
        <button
          onClick={() => setMode('catalog')}
          className={cn(
            'px-3 py-1 rounded-md text-[12px] font-semibold transition-colors',
            mode === 'catalog' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          From Catalog
        </button>
      </div>

      <p className="text-[12px] text-slate-500">
        This task will not be tied to any zone. It appears in the Project Root section.
      </p>

      {mode === 'manual' ? (
        <>
          <div className="grid grid-cols-[120px_1fr_120px_120px] gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code *" autoFocus
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Task name *"
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
            <input value={budgetHours} onChange={(e) => setBudgetHours(e.target.value)} placeholder="Hours" type="number"
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
            <input value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder="Amount" type="number"
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          {/* Deliverable + Service pickers — project-scoped lists, with
              an inline "Create new" that POSTs to the matching catalog
              endpoint and auto-selects the new entry. */}
          <div className="grid grid-cols-2 gap-3">
            <ProjectScopedPicker
              value={serviceTypeId}
              onChange={setServiceTypeId}
              projectTasks={projectTasks}
              fieldKey="serviceType"
              label="Deliverable"
              endpoint="/service-types"
              placeholder="None — pick or create"
            />
            <ProjectScopedPicker
              value={phaseId}
              onChange={setPhaseId}
              projectTasks={projectTasks}
              fieldKey="phase"
              label="Service"
              endpoint="/phases"
              placeholder="None — pick or create"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button onClick={() => { if (!code.trim() || !name.trim()) { notify.warning('Code and Name required'); return; } createTask.mutate(); }}
              disabled={createTask.isPending || !code.trim() || !name.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {createTask.isPending ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Catalog search + list — same shape as CatalogPickerForZone but
              tasks land at zoneId=null. */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search catalog..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
          </div>
          <div className="max-h-[360px] overflow-y-auto border border-slate-100 rounded-lg">
            {catalogLoading ? (
              <p className="py-8 text-center text-sm text-slate-400">Loading catalog...</p>
            ) : !catalogEntry ? (
              <p className="py-8 text-center text-sm text-slate-400">No task catalog found. Create one in Templates → Task Catalog.</p>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">{search ? 'No tasks match.' : 'Catalog is empty.'}</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100 bg-slate-50 text-xs">
                  <th className="px-3 py-2 w-10"></th>
                  <th className="px-3 py-2 text-left font-medium">Code</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr></thead>
                <tbody>
                  {filtered.map((t: any) => (
                    <tr key={t.id} className={cn('border-b border-slate-50 cursor-pointer', selected.has(t.id) ? 'bg-blue-50' : 'hover:bg-slate-50')} onClick={() => toggleSelected(t.id)}>
                      <td className="px-3 py-2"><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelected(t.id)} className="h-3.5 w-3.5" /></td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{t.code || '-'}</td>
                      <td className="px-3 py-2 font-medium">{t.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetHours ? Number(t.defaultBudgetHours) : '-'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{t.defaultBudgetAmount ? Number(t.defaultBudgetAmount).toLocaleString() : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">{selected.size} selected · {filtered.length} in catalog</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
              <button
                onClick={addFromCatalog}
                disabled={adding || selected.size === 0}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {adding ? 'Adding...' : `Add ${selected.size || ''} task${selected.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Add Root Deliverable Dialog (template → tasks at project root) ──────────
//
// Picks a deliverable template (template type=task_list) and materializes
// its tasks at the project root (zoneId=null). Mirrors the "Add Zone from
// Template" flow but skips the zone-creation step.

function AddRootDeliverableDialog({ projectId, onClose, onApplied }: { projectId: number; onClose: () => void; onApplied: () => void }) {
  const [search, setSearch] = useState('');
  const [applying, setApplying] = useState(false);

  // The /templates listing endpoint REPLACES `templateTasks` with a
  // synthesized [SERVICE:xxx] placeholder list for the UI's services
  // badge — it isn't the real task catalog. To materialize a deliverable
  // we have to fetch GET /templates/:id which returns the actual tasks
  // (with code/name/budgetHours/serviceType/etc).
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['templates', 'task_list'],
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data?.data ?? r.data),
    staleTime: 5 * 60 * 1000,
  });

  const list = (Array.isArray(templates) ? templates : [])
    .filter((t: any) => t.code !== '__TASK_CATALOG__')
    .filter((t: any) => !search.trim()
      || t.name?.toLowerCase().includes(search.toLowerCase())
      || t.code?.toLowerCase().includes(search.toLowerCase()));

  // Real (direct) task count — the rollup endpoint exposes this as
  // _count.templateRootTasks. Fall back through legacy fields so older
  // server responses still show something sensible.
  const taskCountFor = (t: any) =>
    t._count?.templateRootTasks
    ?? t._count?.templateTasks  // before the rollup change
    ?? 0;

  const applyTemplate = async (template: any) => {
    if (applying) return;
    setApplying(true);
    try {
      // Fetch the real template detail (with the actual templateTasks
      // array — code, name, budgetHours, etc). The listing endpoint
      // returns a fake placeholder list and can't be used here.
      const detailResp = await client.get(`/templates/${template.id}`);
      const detail = detailResp.data?.data ?? detailResp.data;
      const tasks: any[] = (detail?.templateTasks ?? []).filter(
        // Skip [SERVICE:xxx] marker rows (synthetic) — we want real tasks.
        (t: any) => !(t.description?.match?.(/^\[SERVICE:.+\]$/)),
      );

      if (tasks.length === 0) {
        notify.warning('Template has no tasks');
        setApplying(false);
        return;
      }

      // Find-or-create a ServiceType (= Deliverable identity) matching
      // the template name, so every materialized task carries the
      // deliverable label even when the source TemplateTask had no
      // serviceTypeId of its own. This is what makes "Add Deliverable
      // X" group together as "X" in the Deliverable view.
      let deliverableServiceTypeId: number | null = null;
      try {
        const stListResp = await client.get('/service-types');
        const stList: any[] = stListResp.data?.data ?? stListResp.data ?? [];
        const existing = (Array.isArray(stList) ? stList : []).find(
          (s: any) => s.name === template.name,
        );
        if (existing) {
          deliverableServiceTypeId = existing.id;
        } else {
          const createResp = await client.post('/service-types', {
            name: template.name,
            color: template.phase?.color ?? null,
          });
          const created = createResp.data?.data ?? createResp.data;
          deliverableServiceTypeId = created?.id ?? null;
        }
      } catch {
        // Non-fatal — tasks still get phaseId, just won't have a
        // dedicated Deliverable identity.
      }

      const results = await Promise.allSettled(
        tasks.map((t: any) => tasksApi.create({
          projectId,
          code: t.code,
          name: t.name,
          description: t.description,
          budgetHours: t.defaultBudgetHours ? Number(t.defaultBudgetHours) : undefined,
          budgetAmount: t.defaultBudgetAmount ? Number(t.defaultBudgetAmount) : undefined,
          // Deliverable: prefer the template-task's explicit serviceType
          // if it was set, otherwise tag with the template-level
          // ServiceType we just resolved. Either way every task ends up
          // with a deliverable label, satisfying the user's "every
          // Deliverable belongs to a Service" model.
          serviceTypeId: t.serviceTypeId ?? deliverableServiceTypeId ?? undefined,
          // Service: the template's parent phase (= Service the
          // deliverable belongs to). Falls back to the template-task's
          // own phase if the template itself isn't linked.
          phaseId: template.phaseId ?? t.phaseId ?? undefined,
        } as any)),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      if (fail === 0) notify.success(`Created ${ok} task${ok !== 1 ? 's' : ''}`, { code: 'DELIVERABLE-APPLY-200' });
      else if (ok > 0) notify.warning(`Created ${ok}, ${fail} failed`, { code: 'DELIVERABLE-APPLY-207' });
      else notify.error('Failed to apply deliverable', { code: 'DELIVERABLE-APPLY-500' });
      onApplied();
      onClose();
    } catch (err: any) {
      notify.apiError(err, 'Failed to apply deliverable');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="bg-white rounded-[14px] border border-slate-200 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-slate-900">Add Deliverable at Project Root</h3>
        <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-[12px] text-slate-500">Pick a deliverable template; its tasks are added directly to this project (no zone).</p>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deliverables..."
        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
      <div className="max-h-[360px] overflow-y-auto border border-slate-100 rounded-lg">
        {isLoading ? <p className="py-8 text-center text-sm text-slate-400">Loading...</p>
          : list.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">No deliverables found</p>
          : list.map((t: any) => {
            const count = taskCountFor(t);
            return (
              <button key={t.id} onClick={() => applyTemplate(t)} disabled={applying || count === 0}
                className="w-full text-left px-3 py-2.5 border-b border-slate-100 last:border-0 hover:bg-blue-50/40 disabled:opacity-50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{t.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {t.phase?.name ? <span className="rounded px-1 py-0.5 bg-violet-50 text-violet-700">{t.phase.name}</span> : null}
                      <span className={cn('ml-1.5', count === 0 && 'text-amber-600')}>
                        {count} task{count !== 1 ? 's' : ''}
                      </span>
                    </p>
                  </div>
                  <Plus className="h-4 w-4 text-blue-500 shrink-0" />
                </div>
              </button>
            );
          })
        }
      </div>
      <div className="flex justify-end">
        <button onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Close</button>
      </div>
    </div>
  );
}

// ─── Zone Group (collapsible) with task table ────────────────────────────────

function ZoneGroup({ zone, tasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, thClass, handleSort, sortIcon, selectedTaskIds, onToggleTask, onToggleMany }: any) {
  const [collapsed, setCollapsed] = useState(false);
  useBulkCollapseSync(setCollapsed);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showTaskMenu, setShowTaskMenu] = useState(false);
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const hours = tasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const amount = tasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  const loggedHours = Math.round(tasks.reduce((s: number, t: any) => s + Number(t.loggedMinutes || 0), 0) / 60 * 10) / 10;

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-2.5 px-5 py-2.5 bg-[#FAFBFC] cursor-pointer" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight className="w-3 h-3 text-slate-400" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
        <span className="text-[13px] font-semibold text-slate-900 truncate" title={zone.name}>{zone.name}</span>
        <span className="rounded-[5px] bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-400">{zone.zoneType}</span>
        <span className="ml-auto text-[11px] font-medium text-slate-400">
          {tasks.length} tasks · {hours}h budget
          <span className={cn('ml-1 font-semibold', loggedHours === 0 ? 'text-slate-400' : loggedHours > hours && hours > 0 ? 'text-red-500' : 'text-blue-500')}>
            · {loggedHours}h logged
          </span>
          <span> · ₪{amount.toLocaleString()}</span>
        </span>
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setShowTaskMenu(!showTaskMenu)} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1">
            <Plus className="w-3 h-3" /> Add Task
          </button>
          {showTaskMenu && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5">
              <button onClick={() => { setShowCatalogPicker(true); setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-50">From Catalog</button>
              <button onClick={() => { setShowAddTask(true); setShowTaskMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-50">Create New Task</button>
            </div>
          )}
        </div>
        <button onClick={(e) => { e.stopPropagation(); if (confirm(`Delete zone "${zone.name}" and all its tasks?`)) onDeleteZone(zone.id); }}
          className="w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {!collapsed && (
        <>
          {showAddTask && (
            <div className="px-5 py-2 bg-blue-50/20 flex items-center gap-2 border-b border-slate-50">
              <input value={newTask.code} onChange={(e) => setNewTask(f => ({ ...f, code: e.target.value }))} placeholder="Code *" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
              <input value={newTask.name} onChange={(e) => setNewTask(f => ({ ...f, name: e.target.value }))} placeholder="Task name *" className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetHours} onChange={(e) => setNewTask(f => ({ ...f, budgetHours: e.target.value }))} placeholder="Hours" type="number" className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetAmount} onChange={(e) => setNewTask(f => ({ ...f, budgetAmount: e.target.value }))} placeholder="Amount" type="number" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <button onClick={() => { if (!newTask.code.trim() || !newTask.name.trim()) { notify.warning('Code and Name required'); return; } createTask.mutate({ zoneId: zone.id, code: newTask.code.trim(), name: newTask.name.trim(), budgetHours: newTask.budgetHours ? Number(newTask.budgetHours) : undefined, budgetAmount: newTask.budgetAmount ? Number(newTask.budgetAmount) : undefined }); }}
                disabled={createTask.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">Save</button>
              <button onClick={() => setShowAddTask(false)} className="text-[11px] text-slate-400 hover:text-slate-600 px-2 py-1.5">Cancel</button>
            </div>
          )}
          <table className="w-full table-fixed">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="w-10 pl-5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                    checked={tasks.length > 0 && tasks.every((t: any) => selectedTaskIds?.has(t.id))}
                    ref={(el) => {
                      if (el) {
                        const someSelected = tasks.some((t: any) => selectedTaskIds?.has(t.id));
                        const allSelected = tasks.length > 0 && tasks.every((t: any) => selectedTaskIds?.has(t.id));
                        el.indeterminate = someSelected && !allSelected;
                      }
                    }}
                    onChange={(e) => onToggleMany?.(tasks.map((t: any) => t.id), e.target.checked)}
                  />
                </th>
                <th className={cn(thClass, 'w-20')} onClick={() => handleSort('code')}>Code{sortIcon('code')}</th>
                <th className={thClass} onClick={() => handleSort('name')}>Task Name{sortIcon('name')}</th>
                <th className={cn(thClass, 'w-28')} onClick={() => handleSort('zone')}>Zone{sortIcon('zone')}</th>
                <th className={cn(thClass, 'w-28')} onClick={() => handleSort('service')}>Deliverable{sortIcon('service')}</th>
                <th className={cn(thClass, 'w-20')} onClick={() => handleSort('phase')}>Service{sortIcon('phase')}</th>
                <th className={cn(thClass, 'w-14 text-right')} onClick={() => handleSort('hours')}>Est. Hours{sortIcon('hours')}</th>
                <th className={cn(thClass, 'w-16 text-right')}>Logged</th>
                <th className={cn(thClass, 'w-20 text-right')} onClick={() => handleSort('amount')}>Amount{sortIcon('amount')}</th>
                <th className={cn(thClass, 'w-24')}>Due Date</th>
                <th className={cn(thClass, 'w-28')}>Assignee</th>
                <th className={cn(thClass, 'w-24')}>Status</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="text-[13px]">
              {tasks.map((task: any, idx: number) => {
                const st = statusMap[task.status] || statusMap.not_started;
                const isSelected = selectedTaskIds?.has(task.id) ?? false;
                const svcName = task.serviceType?.name || task.phaseMilestoneName || task.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || null;
                const svcColor = task.serviceType?.color || '#3B82F6';
                const dueDate = task.endDate ? task.endDate.split('T')[0] : '';
                return (
                  <tr key={task.id} className={cn(
                    'border-b hover:bg-blue-50/30 transition-colors',
                    isSelected ? 'bg-blue-50/60 border-slate-200' : idx % 2 === 0 ? 'bg-white border-slate-100' : 'bg-slate-50/50 border-slate-100',
                  )}>
                    <td className="pl-5 py-2">
                      <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer" checked={isSelected} onChange={() => onToggleTask?.(task.id)} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs font-medium text-slate-500">{task.code || '-'}</td>
                    <td className="px-3 py-2 font-medium text-slate-900">{task.name}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.zone?.name || '-'}</td>
                    <td className="px-3 py-2">{svcName ? <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold" style={{ backgroundColor: `${svcColor}15`, color: svcColor }}>{svcName}</span> : <span className="text-slate-300">-</span>}</td>
                    <td className="px-3 py-2 text-[12px] text-slate-500">{task.phase?.name || '-'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-medium text-slate-700">{task.budgetHours ? `${Number(task.budgetHours)}h` : '-'}</td>
                    {/* Reported / logged time on this task. Red if it has
                        exceeded the estimate. Read-only here (logging
                        happens on the task drawer or My Tasks). */}
                    {(() => {
                      const lh = Number(task.loggedMinutes ?? 0) / 60;
                      const bg = Number(task.budgetHours ?? 0);
                      const over = bg > 0 && lh > bg;
                      return (
                        <td className={cn(
                          'px-3 py-2 text-right font-mono text-xs',
                          lh === 0 ? 'text-slate-300' : over ? 'text-red-600 font-bold' : 'text-slate-700 font-medium',
                        )}>
                          {lh > 0 ? `${lh.toFixed(1)}h` : '-'}
                        </td>
                      );
                    })()}
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700">{task.budgetAmount ? `₪${Number(task.budgetAmount).toLocaleString()}` : '-'}</td>
                    <td className="px-3 py-2"><input type="date" value={dueDate} className="w-full px-1 py-0.5 rounded border border-slate-200 text-[10px] text-slate-600 bg-transparent focus:outline-none focus:ring-1 focus:ring-blue-400" /></td>
                    <td className="px-3 py-2">
                      <AssigneePicker task={task} members={members} projectId={projectId} onUpdate={onUpdate} />
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn('inline-block rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold', st.bg, st.text)}>{st.label}</span>
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => onDeleteTask(task.id)} className="w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {tasks.length === 0 && !showAddTask && (
                <tr><td colSpan={12} className="px-5 py-6 text-center text-[13px] text-slate-400">No tasks.</td></tr>
              )}
            </tbody>
          </table>

          {showCatalogPicker && (
            <CatalogPickerForZone
              zoneId={zone.id}
              projectId={projectId}
              onClose={() => setShowCatalogPicker(false)}
              onDone={() => { setShowCatalogPicker(false); onUpdate(); }}
            />
          )}
        </>
      )}
    </div>
  );
}


// ─── Sortable wrapper for zones at any depth ──────────────────────────────────
// Thin shell around HierarchicalZoneGroup that registers the zone with dnd-kit
// using a string id like "z-12" — kept separate from numeric task ids so the
// dragEnd handler can dispatch the right path. Used at every depth: top-level
// zones live in an outer SortableContext (in PlanningView), sub-zones live in
// their parent's SortableContext (rendered inside HierarchicalZoneGroup just
// before each child group).
//
// Important: we DON'T wrap any of this in an outer SortableContext that lists
// task ids. Each task already registers itself globally through its own
// useSortable, so dnd-kit's collision detection sees every task without it.

function SortableZone(props: any) {
  const sortableId = `z-${props.zone.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <HierarchicalZoneGroup
        {...props}
        zoneDragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ─── Hierarchical Zone Group — flat tree style with colored borders ──────────

function HierarchicalZoneGroup({ zone, allTasks, members, projectId, onUpdate, onDeleteTask, onDeleteZone, onDuplicateZone, thClass, handleSort, sortIcon, depth, selectedTaskIds, onToggleTask, onToggleMany, zoneDragHandleProps }: any) {
  const [collapsed, setCollapsed] = useState(false);
  useBulkCollapseSync(setCollapsed);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [showPhasePicker, setShowPhasePicker] = useState(false);
  const [newTask, setNewTask] = useState({ code: '', name: '', budgetHours: '', budgetAmount: '' });
  const [newZone, setNewZone] = useState({ name: '', zoneType: 'zone' });
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicateName, setDuplicateName] = useState('');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const queryClient = useQueryClient();

  const createTask = useMutation({
    mutationFn: (data: any) => tasksApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddTask(false); setNewTask({ code: '', name: '', budgetHours: '', budgetAmount: '' }); notify.success('Task created', { code: 'TASK-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create task'),
  });

  const createZoneMutation = useMutation({
    mutationFn: (data: any) => zonesApi.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['planning', projectId] }); setShowAddZone(false); setNewZone({ name: '', zoneType: 'zone' }); notify.success('Sub-zone created', { code: 'ZONE-CREATE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to create zone'),
  });

  const ZONE_TYPES = ['site', 'building', 'level', 'zone', 'area', 'section', 'wing', 'floor'];

  const directTasks = allTasks.filter((t: any) => t.zoneId === zone.id);
  const allZoneIds = new Set<number>();
  function collectIds(z: any) { allZoneIds.add(z.id); (z.children || []).forEach(collectIds); }
  collectIds(zone);
  const allZoneTasks = allTasks.filter((t: any) => allZoneIds.has(t.zoneId));
  const totalHours = allZoneTasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = allZoneTasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  // Sum of all employee-reported time on tasks in this zone (and its sub-zones).
  const totalLoggedMinutes = allZoneTasks.reduce((s: number, t: any) => s + Number(t.loggedMinutes || 0), 0);
  const totalLoggedHours = Math.round(totalLoggedMinutes / 60 * 10) / 10;
  const hasChildren = zone.children?.length > 0;

  // Zone type colors from design system
  const zoneColors: Record<string, { border: string; bg: string; text: string }> = {
    site: { border: 'border-l-indigo-400', bg: 'bg-indigo-50', text: 'text-indigo-700' },
    building: { border: 'border-l-amber-500', bg: 'bg-amber-50', text: 'text-amber-700' },
    level: { border: 'border-l-teal-400', bg: 'bg-teal-50', text: 'text-teal-700' },
    zone: { border: 'border-l-amber-400', bg: 'bg-amber-50', text: 'text-amber-600' },
    area: { border: 'border-l-purple-400', bg: 'bg-purple-50', text: 'text-purple-700' },
    floor: { border: 'border-l-blue-400', bg: 'bg-blue-50', text: 'text-blue-700' },
    section: { border: 'border-l-teal-400', bg: 'bg-teal-50', text: 'text-teal-700' },
    wing: { border: 'border-l-pink-400', bg: 'bg-pink-50', text: 'text-pink-700' },
  };
  const zc = zoneColors[zone.zoneType] || zoneColors.zone;

  return (
    <div style={{ marginLeft: depth > 0 ? depth * 28 : 0 }} className={cn(depth === 0 && 'rounded-[14px] border border-slate-200 bg-white mb-3 shadow-sm')}>
      {/* Zone row — full width with colored left border */}
      <div className={cn('flex items-center gap-2.5 py-3 px-4 border-l-[3px] cursor-pointer hover:bg-slate-50/80 group transition-colors duration-100', zc.border, depth === 0 ? 'bg-slate-50/60' : 'border-b border-slate-100')}
        onClick={() => setCollapsed(!collapsed)}>
        {/* Drag handle — only top-level zones (passed zoneDragHandleProps
            from the SortableTopZone wrapper). Sub-zones get a placeholder
            to keep the column alignment. Same UX shape as the task grip. */}
        {zoneDragHandleProps ? (
          <button
            type="button"
            aria-label="Drag to reorder zone"
            title="Drag to reorder"
            {...zoneDragHandleProps}
            onClick={(e) => e.stopPropagation()}
            className="-ml-2 flex h-7 w-7 items-center justify-center rounded cursor-grab active:cursor-grabbing text-slate-400 hover:text-blue-600 hover:bg-blue-50 shrink-0 touch-none focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer shrink-0"
          checked={allZoneTasks.length > 0 && allZoneTasks.every((t: any) => selectedTaskIds?.has(t.id))}
          ref={(el) => {
            if (el) {
              const someSelected = allZoneTasks.some((t: any) => selectedTaskIds?.has(t.id));
              const allSelected = allZoneTasks.length > 0 && allZoneTasks.every((t: any) => selectedTaskIds?.has(t.id));
              el.indeterminate = someSelected && !allSelected;
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleMany?.(allZoneTasks.map((t: any) => t.id), e.target.checked)}
          title={`Select all ${allZoneTasks.length} tasks in this zone`}
        />
        <span className={cn('rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide shrink-0', zc.bg, zc.text)}>{zone.zoneType}</span>
        <span className={cn('font-semibold truncate', depth === 0 ? 'text-[15px] text-slate-900' : 'text-[13px] text-slate-800')} title={zone.name}>{zone.name}</span>
        {hasChildren && <span className="text-[11px] text-slate-400">({zone.children.length} sub-zones)</span>}
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {/* Mini progress bar */}
          {(() => {
            const zoneProgress = totalHours > 0
              ? Math.round(allZoneTasks.reduce((s: number, t: any) => s + (t.completionPct || 0) * Number(t.budgetHours || 0), 0) / totalHours)
              : 0;
            return (
              <div className="flex items-center gap-1.5">
                <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className={cn('h-full rounded-full', zoneProgress >= 80 ? 'bg-emerald-500' : zoneProgress >= 50 ? 'bg-blue-500' : 'bg-amber-500')} style={{ width: `${zoneProgress}%` }} />
                </div>
                <span className="text-[10px] font-semibold text-slate-500">{zoneProgress}%</span>
              </div>
            );
          })()}
          <span className="text-[11px] font-medium text-slate-400">
            {allZoneTasks.length} tasks · {totalHours}h budget
            {/* Always show the zone's logged-hours total, even when 0, so PMs
                see at a glance how much of the budget has been consumed.
                Red when actuals exceed budget. */}
            <span className={cn('ml-1 font-semibold', totalLoggedHours === 0 ? 'text-slate-400' : totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-500' : 'text-blue-500')}>
              · {totalLoggedHours}h logged
            </span>
            <span> · ₪{totalAmount.toLocaleString()}</span>
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <div className="relative">
            <button onClick={() => setShowAddMenu(!showAddMenu)} className="bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add
            </button>
            {showAddMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5">
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Tasks</div>
                <button onClick={() => { setShowAddTask(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Create New Task</button>
                <button onClick={() => { setShowCatalogPicker(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Task from Catalog</button>
                <div className="my-1 border-t border-slate-100" />
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Deliverable</div>
                <button onClick={() => { setShowPhasePicker(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">From Template</button>
                <div className="my-1 border-t border-slate-100" />
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Zones</div>
                <button onClick={() => { setShowAddZone(true); setShowAddMenu(false); setCollapsed(false); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-slate-700 hover:bg-slate-50">Add Sub-Zone</button>
              </div>
            )}
          </div>
          {depth === 0 && onDuplicateZone && (
            <button onClick={() => { setDuplicateName(`${zone.name} (copy)`); setShowDuplicateModal(true); }}
              className="text-slate-400 hover:text-blue-600 text-[11px] font-medium px-2 py-1 rounded-md hover:bg-blue-50 flex items-center gap-1">
              <Copy className="w-3 h-3" /> Dup
            </button>
          )}
          <button onClick={() => { if (confirm(`Delete "${zone.name}"?`)) onDeleteZone(zone.id); }}
            className="w-[22px] h-[22px] rounded-[5px] hover:bg-red-50 flex items-center justify-center text-slate-300 hover:text-red-600">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {showAddTask && (
            <div style={{ marginLeft: 28 }} className="flex items-center gap-2 py-2 px-4 border-b border-slate-50 bg-blue-50/20">
              <input value={newTask.code} onChange={(e) => setNewTask(f => ({ ...f, code: e.target.value }))} placeholder="Code *" className="w-20 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" autoFocus />
              <input value={newTask.name} onChange={(e) => setNewTask(f => ({ ...f, name: e.target.value }))} placeholder="Task name *" className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetHours} onChange={(e) => setNewTask(f => ({ ...f, budgetHours: e.target.value }))} placeholder="Hrs" type="number" className="w-14 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <input value={newTask.budgetAmount} onChange={(e) => setNewTask(f => ({ ...f, budgetAmount: e.target.value }))} placeholder="Amt" type="number" className="w-16 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <button onClick={async () => {
                if (!newTask.code.trim() || !newTask.name.trim()) { notify.warning('Code and Name required'); return; }
                const payload = { code: newTask.code.trim(), name: newTask.name.trim(), budgetHours: newTask.budgetHours ? Number(newTask.budgetHours) : undefined, budgetAmount: newTask.budgetAmount ? Number(newTask.budgetAmount) : undefined };
                if (saveToCatalog) { try { const cats = await client.get('/templates?type=task_list').then(r => r.data.data ?? r.data); const cat = (Array.isArray(cats) ? cats : []).find((t: any) => t.code === '__TASK_CATALOG__'); if (cat) await client.post(`/templates/${cat.id}/tasks`, { ...payload, defaultBudgetHours: payload.budgetHours, defaultBudgetAmount: payload.budgetAmount }); } catch {} }
                createTask.mutate({ zoneId: zone.id, ...payload });
              }} disabled={createTask.isPending} className="bg-blue-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">Save</button>
              <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={saveToCatalog} onChange={(e) => setSaveToCatalog(e.target.checked)} className="h-3 w-3 rounded" />Catalog</label>
              <button onClick={() => setShowAddTask(false)} className="text-[11px] text-slate-400 px-1">✕</button>
            </div>
          )}

          {showAddZone && (
            <div style={{ marginLeft: 28 }} className="flex items-center gap-2 py-2 px-4 border-b border-slate-50 bg-amber-50/30">
              <input value={newZone.name} onChange={(e) => setNewZone(f => ({ ...f, name: e.target.value }))} placeholder="Zone name *" autoFocus
                className="flex-1 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none" />
              <select value={newZone.zoneType} onChange={(e) => setNewZone(f => ({ ...f, zoneType: e.target.value }))}
                className="w-28 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none">
                {ZONE_TYPES.map(zt => <option key={zt} value={zt}>{zt.charAt(0).toUpperCase() + zt.slice(1)}</option>)}
              </select>
              <button onClick={() => {
                if (!newZone.name.trim()) { notify.warning('Zone name is required'); return; }
                createZoneMutation.mutate({ projectId, parentId: zone.id, name: newZone.name.trim(), zoneType: newZone.zoneType });
              }} disabled={createZoneMutation.isPending} className="bg-amber-600 text-white text-[11px] font-semibold px-3 py-1.5 rounded-md disabled:opacity-50">
                {createZoneMutation.isPending ? 'Creating...' : 'Add Zone'}
              </button>
              <button onClick={() => setShowAddZone(false)} className="text-[11px] text-slate-400 px-1">✕</button>
            </div>
          )}

          {/* Task column header row — border-l-[3px] transparent to match body rows' colored left border */}
          {directTasks.length > 0 && (
            <div style={{ marginLeft: 28 }} className={cn(TASK_GRID, 'py-1.5 px-4 bg-slate-50/70 border-b border-l-[3px] border-l-transparent border-slate-100 text-[10px] uppercase font-semibold text-slate-400 tracking-wider')}>
              <span />
              <span />
              <span>Code</span>
              <span>Task Name</span>
              <span>Zone</span>
              <span>Deliverable</span>
              <span>Service</span>
              <span className="text-right">Est. Hours</span>
              <span className="text-right">Logged</span>
              <span className="text-right">Amount</span>
              <span>Est. Start</span>
              <span>Due Date</span>
              <span>Assignees</span>
              <span>Status</span>
              <span className="w-5 shrink-0" />
            </div>
          )}
          <SortableTaskList
            tasks={directTasks}
            zoneId={zone.id}
            projectId={projectId}
            members={members}
            selectedTaskIds={selectedTaskIds}
            onToggleTask={onToggleTask}
            onUpdate={onUpdate}
            onDeleteTask={onDeleteTask}
          />

          {hasChildren && (
            // Sub-zones get their own SortableContext scoped to this parent's
            // child list. Sortable items are the child string ids ("z-<n>").
            // dragEnd checks that source + target share a parent before
            // reordering, so a "Floor 1" can only be moved up/down among
            // siblings under the same parent for now.
            <SortableContext
              items={zone.children.map((c: any) => `z-${c.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {zone.children.map((child: any) => (
                <SortableZone key={child.id} zone={child} allTasks={allTasks} members={members} projectId={projectId}
                  onUpdate={onUpdate} onDeleteTask={onDeleteTask} onDeleteZone={onDeleteZone} onDuplicateZone={onDuplicateZone}
                  thClass={thClass} handleSort={handleSort} sortIcon={sortIcon} depth={depth + 1}
                  selectedTaskIds={selectedTaskIds} onToggleTask={onToggleTask} onToggleMany={onToggleMany} />
              ))}
            </SortableContext>
          )}
        </>
      )}

      {showCatalogPicker && (
        <CatalogPickerForZone
          zoneId={zone.id}
          projectId={projectId}
          onClose={() => setShowCatalogPicker(false)}
          onDone={() => { setShowCatalogPicker(false); onUpdate(); }}
        />
      )}

      {showPhasePicker && (
        <PhaseTemplatePickerForZone
          zoneId={zone.id}
          projectId={projectId}
          onClose={() => setShowPhasePicker(false)}
          onDone={() => { setShowPhasePicker(false); onUpdate(); }}
        />
      )}

      {showDuplicateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setShowDuplicateModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">Duplicate Zone</h3>
              <p className="text-[13px] text-slate-400 mt-0.5">Copy "{zone.name}" with all tasks and sub-zones</p>
            </div>
            <div className="p-5">
              <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">New Zone Name *</label>
              <input value={duplicateName} onChange={(e) => setDuplicateName(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && duplicateName.trim()) { onDuplicateZone(zone.id, duplicateName.trim()); setShowDuplicateModal(false); } }}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none" />
            </div>
            <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setShowDuplicateModal(false)} className="bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
              <button onClick={() => { if (duplicateName.trim()) { onDuplicateZone(zone.id, duplicateName.trim()); setShowDuplicateModal(false); } }}
                disabled={!duplicateName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">Duplicate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ─── Project Root Group ──────────────────────────────────────────────────────
//
// Renders tasks whose zoneId is null — i.e. tasks that belong directly to
// the project, not to any zone. Visually styled like a top-level zone
// header (collapsible, with totals) but without zone-specific affordances
// (no zone-type pill, no duplicate, no add-sub-zone). Uses the same
// SortableTaskList as zones so task DnD continues to work — including
// dragging a root task INTO a zone (setZoneId) once the cross-zone move
// confirm flow is wired up.

// Single deliverable group inside the project root. Renders one
// collapsible section with its own totals + task list. Used both for
// real deliverables (tasks grouped by phaseId) and the "No Deliverable"
// fallback bucket for ad-hoc root tasks.
function ProjectRootDeliverableGroup({
  projectId, label, serviceLabel, color, tasks, members, onUpdate, onDeleteTask,
  selectedTaskIds, onToggleTask, onToggleMany,
  dndId,
}: {
  projectId: number;
  label: string;
  /** Parent Service (phase) name shown below the deliverable label.
   *  Optional — when missing the row stays compact. */
  serviceLabel?: string;
  color: string;
  tasks: any[];
  members: any[];
  onUpdate: () => void; onDeleteTask: (id: number) => void;
  selectedTaskIds: Set<number>; onToggleTask: (id: number) => void;
  onToggleMany: (ids: number[], checked: boolean) => void;
  /** Optional sortable id for DnD (e.g. "d-st-12" or "d-ph-3"). When
   *  set, the card registers with dnd-kit and shows a grip handle on
   *  the header. Cards without an id (the "No Deliverable" orphan
   *  bucket) stay non-draggable. */
  dndId?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useBulkCollapseSync(setCollapsed);
  // useSortable is always called (hooks must be unconditional) but we
  // only attach listeners + transforms when dndId is provided.
  const sortable = useSortable({ id: dndId ?? '__noop__', disabled: !dndId });
  const sortableStyle = dndId
    ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
    : undefined;
  const totalHours = tasks.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = tasks.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  const totalLoggedMinutes = tasks.reduce((s: number, t: any) => s + Number(t.loggedMinutes || 0), 0);
  const totalLoggedHours = Math.round(totalLoggedMinutes / 60 * 10) / 10;

  return (
    <div
      ref={dndId ? sortable.setNodeRef : undefined}
      style={sortableStyle}
      className={cn(
        'rounded-[14px] border border-slate-200 bg-white mb-3 shadow-sm group',
        sortable.isDragging && dndId && 'opacity-50 ring-2 ring-blue-300 z-10',
      )}
      {...(dndId ? sortable.attributes : {})}
    >
      <div
        className="flex items-center gap-2.5 py-3 px-4 border-l-[3px] cursor-pointer hover:bg-slate-50/60"
        style={{ borderLeftColor: color, backgroundColor: `${color}10` }}
        onClick={() => setCollapsed(!collapsed)}
      >
        {/* Drag handle — appears on hover when this card is sortable.
            Listeners are attached only here (not the whole row) so the
            collapse-toggle on row click keeps working. */}
        {dndId ? (
          <button
            type="button"
            aria-label="Drag to reorder deliverable"
            title="Drag to reorder"
            {...sortable.listeners}
            onClick={(e) => e.stopPropagation()}
            className="-ml-1 flex h-6 w-6 items-center justify-center rounded text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-600 cursor-grab active:cursor-grabbing shrink-0 touch-none focus:outline-none focus:ring-2 focus:ring-blue-300 focus:opacity-100"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <input
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer shrink-0"
          checked={tasks.length > 0 && tasks.every((t: any) => selectedTaskIds.has(t.id))}
          ref={(el) => {
            if (el) {
              const some = tasks.some((t: any) => selectedTaskIds.has(t.id));
              const all = tasks.length > 0 && tasks.every((t: any) => selectedTaskIds.has(t.id));
              el.indeterminate = some && !all;
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleMany(tasks.map((t: any) => t.id), e.target.checked)}
          title={`Select all ${tasks.length} tasks in ${label}`}
        />
        <span
          className="rounded-[5px] px-2 py-0.5 text-[11px] font-bold tracking-wide shrink-0"
          style={{ backgroundColor: `${color}25`, color }}
        >
          deliverable
        </span>
        <div className="min-w-0 flex items-baseline gap-1.5">
          <span className="text-[15px] font-semibold text-slate-900 truncate" title={label}>{label}</span>
          {serviceLabel && (
            <span className="text-[11px] text-slate-400 truncate" title={`Service: ${serviceLabel}`}>
              · {serviceLabel}
            </span>
          )}
        </div>
        <span className="ml-auto text-[11px] font-medium text-slate-400">
          {tasks.length} tasks · {totalHours}h budget
          <span className={cn('ml-1 font-semibold', totalLoggedHours === 0 ? 'text-slate-400' : totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-500' : 'text-blue-500')}>
            · {totalLoggedHours}h logged
          </span>
          <span> · ₪{totalAmount.toLocaleString()}</span>
        </span>
      </div>
      {!collapsed && (
        <>
          <div style={{ marginLeft: 28 }} className={cn(TASK_GRID, 'py-1.5 px-4 bg-slate-50/70 border-b border-l-[3px] border-l-transparent border-slate-100 text-[10px] uppercase font-semibold text-slate-400 tracking-wider')}>
            <span /><span />
            <span>Code</span>
            <span>Task Name</span>
            <span>Zone</span>
            <span>Deliverable</span>
            <span>Service</span>
            <span className="text-right">Est. Hours</span>
            <span className="text-right">Logged</span>
            <span className="text-right">Amount</span>
            <span>Est. Start</span>
            <span>Due Date</span>
            <span>Assignees</span>
            <span>Status</span>
            <span className="w-5 shrink-0" />
          </div>
          <SortableTaskList
            tasks={tasks}
            zoneId={0 /* sentinel — root tasks have zoneId=null, this id only feeds dnd-kit's SortableContext */}
            projectId={projectId}
            members={members}
            selectedTaskIds={selectedTaskIds}
            onToggleTask={onToggleTask}
            onUpdate={onUpdate}
            onDeleteTask={onDeleteTask}
          />
        </>
      )}
    </div>
  );
}

// Project-root section: bucket orphan tasks (zoneId=null) by their
// deliverable (phaseId). Each deliverable becomes its own collapsible
// group with independent totals. Tasks with no phaseId go to a generic
// "No Deliverable" bucket so nothing is dropped on the floor.
function ProjectRootGroup({
  projectId, tasks, members, onUpdate, onDeleteTask, selectedTaskIds, onToggleTask, onToggleMany,
}: {
  projectId: number; tasks: any[]; members: any[];
  onUpdate: () => void; onDeleteTask: (id: number) => void;
  selectedTaskIds: Set<number>; onToggleTask: (id: number) => void;
  onToggleMany: (ids: number[], checked: boolean) => void;
}) {
  if (tasks.length === 0) return null;

  // Bucket by Deliverable identity (serviceTypeId) — that's the primary
  // group key in the user's mental model. Tasks without a serviceTypeId
  // fall back to phase, then to a generic "No Deliverable" bucket so
  // nothing is dropped on the floor.
  type Bucket = {
    key: string;
    label: string;          // Deliverable name
    serviceLabel: string;   // Parent Service (phase) name, shown as sub-label
    color: string;
    tasks: any[];
    isOrphan: boolean;      // true for "No Deliverable" bucket
    /** Sortable id for DnD. `d-st-N` for ServiceType buckets, `d-ph-N`
     *  for Phase buckets. The orphan bucket is non-draggable. */
    dndId?: string;
    /** Persisted sort order from the backing entity (ServiceType.sortOrder
     *  or Phase.sortOrder). Drives initial card order — drag-and-drop
     *  writes back to this column. */
    sortOrder: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const t of tasks) {
    const stId: number | null = t.serviceTypeId ?? null;
    const phId: number | null = t.phaseId ?? null;
    let key: string;
    let label: string;
    let color: string;
    let isOrphan = false;
    let dndId: string | undefined;
    let sortOrder = 0;
    if (stId != null) {
      key = `st-${stId}`;
      label = t.serviceType?.name || `Deliverable #${stId}`;
      color = t.serviceType?.color || t.phase?.color || '#8B5CF6';
      dndId = `d-st-${stId}`;
      sortOrder = Number(t.serviceType?.sortOrder ?? 0);
    } else if (phId != null) {
      key = `ph-${phId}`;
      label = t.phase?.name || `Deliverable #${phId}`;
      color = t.phase?.color || '#8B5CF6';
      dndId = `d-ph-${phId}`;
      sortOrder = Number(t.phase?.sortOrder ?? 0);
    } else {
      key = '__none__';
      label = 'No Deliverable';
      color = '#94a3b8'; // slate-400
      isOrphan = true;
    }
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label,
        serviceLabel: t.phase?.name || '',
        color,
        tasks: [],
        isOrphan,
        dndId,
        sortOrder,
      });
    }
    buckets.get(key)!.tasks.push(t);
  }

  // Real deliverables first, ordered by their persisted sortOrder
  // (ascending). Ties break by label alphabetically. "No Deliverable"
  // is always last.
  const sorted = Array.from(buckets.values()).sort((a, b) => {
    if (a.isOrphan !== b.isOrphan) return a.isOrphan ? 1 : -1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label);
  });

  // SortableContext items for DnD — orphan bucket has no dndId so it
  // sits at the bottom and isn't draggable.
  const sortableIds = sorted.filter((b) => b.dndId).map((b) => b.dndId!);

  return (
    <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
      {sorted.map((b) => (
        <ProjectRootDeliverableGroup
          key={b.key}
          projectId={projectId}
          label={b.label}
          serviceLabel={b.serviceLabel}
          color={b.color}
          tasks={b.tasks}
          members={members}
          onUpdate={onUpdate}
          onDeleteTask={onDeleteTask}
          selectedTaskIds={selectedTaskIds}
          onToggleTask={onToggleTask}
          onToggleMany={onToggleMany}
          dndId={b.dndId}
        />
      ))}
    </SortableContext>
  );
}

// ─── Main Planning View ──────────────────────────────────────────────────────

function PlanningView({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showManualZone, setShowManualZone] = useState(false);
  // Project-root creation: tasks/deliverables that attach directly to
  // the project (zoneId=null) instead of a spatial zone. Same UX shape
  // as the zone picker — two flows: from a template, or manual.
  const [showRootTemplate, setShowRootTemplate] = useState(false);
  const [showRootTask, setShowRootTask] = useState(false);
  // Cross-zone DnD confirm: when a task drag ends in a different zone,
  // we hold the resolved move here and surface a confirm modal so the
  // user has to approve the change. Closes (= cancel) on click-away
  // without firing the API.
  const [pendingZoneMove, setPendingZoneMove] = useState<
    | null
    | {
        taskId: number;
        taskName: string;
        fromZoneName: string;
        toZoneName: string;
        execute: () => Promise<void>;
      }
  >(null);
  // Pending task delete — a styled confirm modal replaces the native
  // browser confirm. Same closure-driven shape as pendingZoneMove:
  // build the execute() at request time, run it on confirm, drop the
  // state on cancel. Works for both single-row and bulk deletes.
  const [pendingTaskDelete, setPendingTaskDelete] = useState<
    | null
    | {
        ids: number[];
        names: string[]; // up to 5 names for preview, then "+N more"
        execute: () => Promise<void>;
      }
  >(null);
  const [groupBy, setGroupBy] = useState<'zone' | 'service' | 'phase' | 'none'>('zone');
  // Bulk collapse/expand. `bulkCollapsed` tracks the last toolbar state
  // so the button label flips between "Collapse all" / "Expand all".
  // `bulkVersion` is bumped on every click so cards re-sync even when
  // the desired value is unchanged (see BulkCollapseContext contract).
  const [bulkCollapsed, setBulkCollapsed] = useState(false);
  const [bulkVersion, setBulkVersion] = useState(0);
  const toggleBulkCollapse = () => {
    setBulkCollapsed((v) => !v);
    setBulkVersion((v) => v + 1);
  };
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  // Task filters — empty = no filter. Date filters compare against task.startDate / task.endDate
  // (stored ISO strings; we compare YYYY-MM-DD prefix).
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterStartFrom, setFilterStartFrom] = useState<string>('');
  const [filterStartTo, setFilterStartTo] = useState<string>('');
  const [filterDueFrom, setFilterDueFrom] = useState<string>('');
  const [filterDueTo, setFilterDueTo] = useState<string>('');
  // Has-due-date triage filter. '' = any, 'yes' = only tasks with a due
  // date set, 'no' = only tasks missing one (handy for catching tasks
  // that slipped through scheduling).
  const [filterHasDue, setFilterHasDue] = useState<'' | 'yes' | 'no'>('');

  // ─── Undo Stack ─────────────────────────────────────────────────────────────
  const undoStackRef = useRef<{ label: string; fn: () => Promise<void> }[]>([]);
  const [undoCount, setUndoCount] = useState(0);

  const pushUndo = useCallback((label: string, fn: () => Promise<void>) => {
    undoStackRef.current.push({ label, fn });
    if (undoStackRef.current.length > 30) undoStackRef.current.shift();
    setUndoCount(undoStackRef.current.length);
  }, []);

  const handleUndo = useCallback(async () => {
    const action = undoStackRef.current.pop();
    if (!action) { notify.info('Nothing to undo'); return; }
    try {
      await action.fn();
      queryClient.invalidateQueries({ queryKey: ['planning', projectId] });
      notify.success(`Undo: ${action.label}`, { code: 'UNDO-200' });
    } catch (err: any) {
      notify.apiError(err, 'Undo failed');
    }
    setUndoCount(undoStackRef.current.length);
  }, [queryClient, projectId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo]);

  const toggleTask = (taskId: number) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  };
  const toggleManyTasks = (taskIds: number[], selectAll: boolean) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (selectAll) taskIds.forEach((id) => next.add(id));
      else taskIds.forEach((id) => next.delete(id));
      return next;
    });
  };
  const clearSelection = () => setSelectedTaskIds(new Set());

  const { data: planningData, isLoading } = useQuery({
    queryKey: ['planning', projectId],
    queryFn: () => planningApi.getData(projectId),
    enabled: !!projectId,
  });

  // Fetch service templates to map service name → phase (for phase display/grouping)
  const { data: serviceTemplatesRaw = [] } = useQuery({
    queryKey: ['templates', 'task_list'],
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/templates?type=task_list').then((r) => r.data.data ?? r.data),
  });
  const servicePhaseMap = useMemo(() => {
    const map = new Map<string, { id: number; name: string; code?: string | null }>();
    const list = Array.isArray(serviceTemplatesRaw) ? serviceTemplatesRaw : [];
    for (const t of list) {
      if (t?.phase) map.set(t.name, { id: t.phase.id, name: t.phase.name, code: t.phase.code });
    }
    return map;
  }, [serviceTemplatesRaw]);

  const pd = (planningData as any)?.data ?? planningData;
  const zones = pd?.zones ?? [];
  const rawTasks = pd?.tasks ?? [];

  // Enrich each task with phase (service) + phaseMilestoneName from its template
  const tasks = useMemo(() => {
    return (rawTasks as any[]).map((t) => {
      const svcMatch = t.description?.match(/^\[SERVICE:(.+)\]$/);
      const phaseMilestoneName = svcMatch ? svcMatch[1] : null;
      let enriched = { ...t, phaseMilestoneName };
      if (!enriched.phase && svcMatch) {
        const svcName = svcMatch[1];
        const phase = servicePhaseMap.get(svcName);
        if (phase) enriched = { ...enriched, phase, phaseId: phase.id };
      }
      return enriched;
    });
  }, [rawTasks, servicePhaseMap]);
  const members = pd?.members ?? [];
  const budget = pd?.budgetSummary;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['planning', projectId] });

  const duplicateZone = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => zonesApi.duplicate(id, name),
    onSuccess: () => { invalidate(); notify.success('Zone duplicated', { code: 'ZONE-DUP-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to duplicate zone'),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => { invalidate(); notify.success('Task deleted', { code: 'TASK-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete task'),
  });

  // Open the styled confirm modal for one or more task IDs. Builds the
  // execute() closure here so the modal stays a dumb renderer. Single-
  // row delete uses [id], bulk delete passes the selection set. Falls
  // back to a numeric label when the task name isn't in the loaded set.
  const requestTaskDelete = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const names = tasks
        .filter((t: any) => idSet.has(t.id))
        .map((t: any) => t.name || `#${t.id}`);
      setPendingTaskDelete({
        ids,
        names,
        execute: async () => {
          if (ids.length === 1) {
            // Single — reuse the mutation so toasts + invalidate fire.
            deleteTask.mutate(ids[0]);
            return;
          }
          // Bulk — fire all in parallel, summarise the result.
          const results = await Promise.allSettled(
            ids.map((id) => tasksApi.delete(id)),
          );
          const ok = results.filter((r) => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          invalidate();
          if (ok > 0 && fail === 0) {
            notify.success(`Deleted ${ok} task${ok !== 1 ? 's' : ''}`, { code: 'TASK-DELETE-200' });
          } else if (ok > 0 && fail > 0) {
            notify.warning(`Deleted ${ok}, ${fail} failed`, { code: 'TASK-DELETE-207' });
          } else {
            notify.error('Failed to delete tasks', { code: 'TASK-DELETE-500' });
          }
          // Clear the selection if the bar was driving the action.
          clearSelection();
        },
      });
    },
    [tasks, deleteTask, invalidate],
  );

  const deleteZone = useMutation({
    mutationFn: (id: number) => zonesApi.remove(id),
    onSuccess: () => { invalidate(); notify.success('Zone deleted', { code: 'ZONE-DELETE-200' }); },
    onError: (err: any) => notify.apiError(err, 'Failed to delete zone'),
  });

  // ─── Global DnD for cross-zone task dragging ──────────────────────────────
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  // active id is a number for tasks, "z-<id>" string for zones.
  const [activeDragId, setActiveDragId] = useState<number | string | null>(null);

  const handleGlobalDragStart = (event: DragStartEvent) => {
    const id = event.active.id;
    setActiveDragId(typeof id === 'string' ? id : Number(id));
  };

  const handleGlobalDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Deliverable card reorder: ids of the form "d-st-<id>" (ServiceType
    // bucket) or "d-ph-<id>" (Phase bucket). We compute the new card
    // order across the currently-rendered list, then PATCH the
    // appropriate entity's sortOrder on the backend.
    if (typeof active.id === 'string' && active.id.startsWith('d-')) {
      if (typeof over.id !== 'string' || !over.id.startsWith('d-')) return;

      // Build the current bucket list — depends on whether we're in
      // groupBy=zone (ProjectRootGroup buckets) or alt mode (groups).
      // We rebuild it here from the cached planning data so we don't
      // depend on the consumer's local state.
      type CardEntity = { dndId: string; kind: 'st' | 'ph'; entityId: number };
      const currentCards: CardEntity[] = [];
      const seen = new Set<string>();
      // For zone mode the DnD covers the project-root cards (which are
      // bucketed by ServiceType / Phase). For alt modes, the rendered
      // groups already carry the dndId.
      const sourceList: any[] = groupBy === 'zone'
        ? sorted.filter((t: any) => t.zoneId == null) // root tasks
        : sorted;
      for (const t of sourceList) {
        let dndId: string | undefined;
        let kind: 'st' | 'ph' | null = null;
        let entityId: number | null = null;
        if (groupBy === 'zone' || groupBy === 'service') {
          if (t.serviceTypeId != null) {
            dndId = `d-st-${t.serviceTypeId}`;
            kind = 'st';
            entityId = t.serviceTypeId;
          } else if (t.phaseId != null) {
            dndId = `d-ph-${t.phaseId}`;
            kind = 'ph';
            entityId = t.phaseId;
          }
        } else if (groupBy === 'phase') {
          if (t.phaseId != null) {
            dndId = `d-ph-${t.phaseId}`;
            kind = 'ph';
            entityId = t.phaseId;
          }
        }
        if (dndId && !seen.has(dndId) && kind && entityId != null) {
          seen.add(dndId);
          currentCards.push({ dndId, kind, entityId });
        }
      }

      const fromIdx = currentCards.findIndex((c) => c.dndId === active.id);
      const toIdx = currentCards.findIndex((c) => c.dndId === over.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const reordered = arrayMove(currentCards, fromIdx, toIdx);

      // Persist new sortOrder per affected entity. We only PATCH cards
      // whose order actually changed (cheap; usually just a few).
      const writes: Promise<unknown>[] = [];
      reordered.forEach((c, i) => {
        const endpoint = c.kind === 'st' ? '/service-types' : '/phases';
        writes.push(client.patch(`${endpoint}/${c.entityId}`, { sortOrder: i }));
      });
      try {
        await Promise.all(writes);
        // Refetch planning so card order reflects the new sortOrder.
        // Also invalidate the catalog caches so any open pickers refresh.
        invalidate();
        queryClient.invalidateQueries({ queryKey: ['/service-types'] });
        queryClient.invalidateQueries({ queryKey: ['/phases'] });
      } catch (err: any) {
        notify.apiError(err, 'Failed to reorder deliverables');
      }
      return;
    }

    // Zone reorder: ids of the form "z-<id>" come from SortableZone wrappers
    // at any depth. We only reorder within a single sibling list — moving
    // a sub-zone to a different parent is a separate (more dangerous) action
    // and stays disabled here.
    if (typeof active.id === 'string' && active.id.startsWith('z-')) {
      if (typeof over.id !== 'string' || !over.id.startsWith('z-')) return;
      const fromZoneId = Number(active.id.slice(2));
      const toZoneId = Number(over.id.slice(2));

      // Walk the planning tree once to (a) locate both zones and (b) find
      // the sibling list each lives in (top-level vs some parent's children).
      let fromSiblings: any[] | null = null;
      let toSiblings: any[] | null = null;
      const visit = (siblings: any[]) => {
        for (const z of siblings) {
          if (z.id === fromZoneId) fromSiblings = siblings;
          if (z.id === toZoneId) toSiblings = siblings;
          if (z.children?.length) visit(z.children);
        }
      };
      visit(zones);

      if (!fromSiblings || !toSiblings || fromSiblings !== toSiblings) {
        // Different sibling lists → user is trying to move across parents.
        // Silently ignore for now; moving a zone across parents is a future
        // feature and risks breaking task linkages.
        return;
      }

      const oldIndex = fromSiblings.findIndex((z: any) => z.id === fromZoneId);
      const newIndex = fromSiblings.findIndex((z: any) => z.id === toZoneId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(fromSiblings, oldIndex, newIndex);
      const items = reordered.map((z: any, i: number) => ({ id: z.id, sortOrder: i }));
      try {
        await zonesApi.reorder(items);
        invalidate();
      } catch (err: any) {
        notify.apiError(err, 'Failed to reorder zones');
      }
      return;
    }

    const activeId = Number(active.id);
    const overId = Number(over.id);

    // Find source task and target task
    const activeTask = tasks.find((t: any) => t.id === activeId);
    const overTask = tasks.find((t: any) => t.id === overId);
    if (!activeTask) return;

    // Determine the target zone — if we're dropping on another task, use its zone
    const targetZoneId = overTask ? overTask.zoneId : activeTask.zoneId;
    const sameZone = activeTask.zoneId === targetZoneId;

    // Get the tasks in the target zone (for reordering)
    const targetZoneTasks = tasks.filter((t: any) => t.zoneId === targetZoneId);

    if (sameZone) {
      // Reorder within zone
      const oldIndex = targetZoneTasks.findIndex((t: any) => t.id === activeId);
      const newIndex = targetZoneTasks.findIndex((t: any) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(targetZoneTasks, oldIndex, newIndex);
      const items = reordered.map((t: any, i: number) => ({ id: t.id, sortOrder: i }));
      try {
        await tasksApi.reorder(items);
        invalidate();
      } catch (err: any) {
        notify.apiError(err, 'Failed to reorder tasks');
      }
    } else {
      // Cross-zone move — show a confirm dialog before mutating. Building
      // the API payload here so the user can't change anything between
      // drop and confirm. The execute() closure is stored in state and
      // run on click of the modal's "Move task".
      const oldZoneId = activeTask.zoneId;
      const targetList = [...targetZoneTasks];
      const insertIdx = targetList.findIndex((t: any) => t.id === overId);
      const insertAt = insertIdx >= 0 ? insertIdx : targetList.length;
      targetList.splice(insertAt, 0, activeTask);
      const items = targetList.map((t: any, i: number) => ({
        id: t.id,
        sortOrder: i,
        ...(t.id === activeId ? { zoneId: targetZoneId } : {}),
      }));
      const fromZoneName = activeTask.zone?.name || (activeTask.zoneId == null ? 'Project Root' : '');
      // overTask may be undefined if dropped on empty zone droppable; in
      // that case fall back to the zone-id lookup we already had.
      const toZoneName = overTask?.zone?.name
        || zones.find((z: any) => z.id === targetZoneId)?.name
        || (targetZoneId == null ? 'Project Root' : 'another zone');

      setPendingZoneMove({
        taskId: activeId,
        taskName: activeTask.name || `#${activeId}`,
        fromZoneName,
        toZoneName,
        execute: async () => {
          try {
            await tasksApi.reorder(items);
            invalidate();
            notify.success(`Moved task to ${toZoneName}`, { code: 'TASK-MOVE-200' });
            pushUndo(`move task back to ${fromZoneName}`, async () => {
              await tasksApi.reorder([{ id: activeId, sortOrder: 0, zoneId: oldZoneId }]);
            });
          } catch (err: any) {
            notify.apiError(err, 'Failed to move task');
          }
        },
      });
    }
  };

  // All task IDs for the global sortable context
  const allTaskIds = useMemo(() => tasks.map((t: any) => t.id), [tasks]);

  // Filter
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t: any) => {
      // Free-text search (code / name / zone / service)
      if (q) {
        const hit =
          t.code?.toLowerCase().includes(q) ||
          t.name?.toLowerCase().includes(q) ||
          t.zone?.name?.toLowerCase().includes(q) ||
          t.serviceType?.name?.toLowerCase().includes(q);
        if (!hit) return false;
      }
      // Status (must be exact enum match if set)
      if (filterStatus && t.status !== filterStatus) return false;
      // Estimated-start range — uses the planning field, NOT actual startDate.
      const ts = t.estimatedStartDate ? String(t.estimatedStartDate).slice(0, 10) : '';
      if (filterStartFrom && (!ts || ts < filterStartFrom)) return false;
      if (filterStartTo && (!ts || ts > filterStartTo)) return false;
      // Due-date range
      const td = t.endDate ? String(t.endDate).slice(0, 10) : '';
      if (filterDueFrom && (!td || td < filterDueFrom)) return false;
      if (filterDueTo && (!td || td > filterDueTo)) return false;
      // Has-due-date filter (yes/no/any)
      if (filterHasDue === 'yes' && !td) return false;
      if (filterHasDue === 'no' && td) return false;
      return true;
    });
  }, [tasks, search, filterStatus, filterStartFrom, filterStartTo, filterDueFrom, filterDueTo, filterHasDue]);

  const hasTaskFilter = !!(filterStatus || filterStartFrom || filterStartTo || filterDueFrom || filterDueTo || filterHasDue);
  const clearTaskFilters = () => {
    setFilterStatus('');
    setFilterStartFrom('');
    setFilterStartTo('');
    setFilterDueFrom('');
    setFilterDueTo('');
    setFilterHasDue('');
  };

  // Sort
  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a: any, b: any) => {
      let va: any, vb: any;
      switch (sortCol) {
        case 'code': va = a.code || ''; vb = b.code || ''; break;
        case 'name': va = a.name || ''; vb = b.name || ''; break;
        case 'service': va = a.serviceType?.name || ''; vb = b.serviceType?.name || ''; break;
        case 'phase': va = a.phase?.name || ''; vb = b.phase?.name || ''; break;
        case 'hours': va = Number(a.budgetHours) || 0; vb = Number(b.budgetHours) || 0; break;
        case 'amount': va = Number(a.budgetAmount) || 0; vb = Number(b.budgetAmount) || 0; break;
        default: return 0;
      }
      if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb as string).toLowerCase(); }
      return va < vb ? (sortDir === 'asc' ? -1 : 1) : va > vb ? (sortDir === 'asc' ? 1 : -1) : 0;
    });
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col: string) => { if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(col); setSortDir('asc'); } };
  const sortIcon = (col: string) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const thClass = "px-3 py-1.5 text-left text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] cursor-pointer select-none hover:text-slate-600";

  // Group tasks
  const flatZones = useMemo(() => { const r: any[] = []; function walk(z: any[]) { for (const n of z) { r.push(n); if (n.children) walk(n.children); } } walk(zones); return r; }, [zones]);

  // Group tasks by the chosen criterion. For non-zone modes we also
  // capture a `color`, the backing entity (for DnD reorder writes), and
  // the entity's persisted sortOrder so the cards render in a stable,
  // user-controllable order.
  type Group = {
    key: string;
    label: string;
    serviceLabel: string;
    color: string;
    zone: any | null;
    tasks: any[];
    /** Sortable id (e.g. "d-st-12" or "d-ph-3"). Undefined for the
     *  "No X" orphan bucket and for groupBy='zone'/'none' (which don't
     *  participate in deliverable DnD). */
    dndId?: string;
    /** Persisted sortOrder on the backing entity. Drives card order. */
    sortOrder: number;
  };
  const groups: Group[] = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: 'All Tasks', serviceLabel: '', color: '#8B5CF6', zone: null, tasks: sorted, sortOrder: 0 }];
    if (groupBy === 'zone') {
      return flatZones.map((z: any) => ({ key: String(z.id), label: z.name, serviceLabel: '', color: '#8B5CF6', zone: z, tasks: sorted.filter((t: any) => t.zoneId === z.id), sortOrder: Number(z.sortOrder ?? 0) })).filter((g: any) => g.tasks.length > 0);
    }
    const map = new Map<string, Group>();
    for (const t of sorted) {
      let key = '';
      let label = '';
      let serviceLabel = '';
      let color = '#8B5CF6';
      let dndId: string | undefined;
      let sortOrder = 0;
      if (groupBy === 'service') {
        // Deliverable view. ServiceType is primary; Phase fallback for
        // legacy tasks. We track which kind so DnD can write back to
        // the right entity.
        if (t.serviceTypeId != null) {
          label = t.serviceType?.name || `Deliverable #${t.serviceTypeId}`;
          color = t.serviceType?.color || t.phase?.color || '#8B5CF6';
          dndId = `d-st-${t.serviceTypeId}`;
          sortOrder = Number(t.serviceType?.sortOrder ?? 0);
          key = `st-${t.serviceTypeId}`;
        } else if (t.phaseId != null) {
          label = t.phase?.name || `Deliverable #${t.phaseId}`;
          color = t.phase?.color || '#8B5CF6';
          dndId = `d-ph-${t.phaseId}`;
          sortOrder = Number(t.phase?.sortOrder ?? 0);
          key = `ph-${t.phaseId}`;
        } else {
          label = t.description?.match(/^\[SERVICE:(.+)\]$/)?.[1] || 'No Deliverable';
          color = '#94a3b8';
          key = `none-${label}`;
        }
        serviceLabel = t.phase?.name || '';
      } else {
        // "phase" groupBy = Service grouping. Each card is a Phase.
        if (t.phaseId != null) {
          label = t.phase?.name || `Service #${t.phaseId}`;
          color = t.phase?.color || '#8B5CF6';
          dndId = `d-ph-${t.phaseId}`;
          sortOrder = Number(t.phase?.sortOrder ?? 0);
          key = `ph-${t.phaseId}`;
        } else {
          label = 'No Service';
          color = '#94a3b8';
          key = 'none';
        }
        serviceLabel = '';
      }
      if (!map.has(key)) map.set(key, { key, label, serviceLabel, color, zone: null, tasks: [], dndId, sortOrder });
      map.get(key)!.tasks.push(t);
    }
    // Real labels first by sortOrder (ascending), then alpha; "No X"
    // buckets always last.
    return Array.from(map.values()).sort((a, b) => {
      const aIsNone = a.label.startsWith('No ');
      const bIsNone = b.label.startsWith('No ');
      if (aIsNone !== bIsNone) return aIsNone ? 1 : -1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.label.localeCompare(b.label);
    });
  }, [sorted, groupBy, flatZones]);

  const totalHours = sorted.reduce((s: number, t: any) => s + Number(t.budgetHours || 0), 0);
  const totalAmount = sorted.reduce((s: number, t: any) => s + Number(t.budgetAmount || 0), 0);
  const totalLoggedMinutes = sorted.reduce((s: number, t: any) => s + (t.loggedMinutes || 0), 0);
  const totalLoggedHours = Math.round(totalLoggedMinutes / 60 * 10) / 10;

  if (isLoading) return <div className="flex h-96 items-center justify-center text-[13px] text-slate-400">Loading...</div>;

  return (
    <BulkCollapseContext.Provider value={{ desired: bulkCollapsed, version: bulkVersion }}>
    <div className="space-y-5">
      {/* Template picker / manual zone dialogs */}
      {showTemplatePicker && <TemplatePickerDialog projectId={projectId} onClose={() => setShowTemplatePicker(false)} onApplied={invalidate} />}
      {showManualZone && <AddZoneManuallyDialog projectId={projectId} onClose={() => setShowManualZone(false)} onCreated={invalidate} />}
      {/* Project-root deliverable + task dialogs */}
      {showRootTemplate && <AddRootDeliverableDialog projectId={projectId} onClose={() => setShowRootTemplate(false)} onApplied={invalidate} />}
      {showRootTask && <AddRootTaskDialog projectId={projectId} projectTasks={tasks} onClose={() => setShowRootTask(false)} onCreated={invalidate} />}

      {/* Cross-zone move confirm — modal blocks the UI until the user
          either approves or cancels. Cancel does nothing (the optimistic
          DOM never updated, so canceling = the original state stays). */}
      {pendingZoneMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={() => setPendingZoneMove(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[460px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Move task between zones?</h3>
                <p className="text-[13px] text-slate-500 mt-0.5">This will reassign the task to a different zone.</p>
              </div>
            </div>
            <div className="px-5 py-4 text-[13px] text-slate-700 space-y-1.5">
              <div><span className="text-slate-400">Task:</span> <span className="font-semibold text-slate-900">{pendingZoneMove.taskName}</span></div>
              <div><span className="text-slate-400">From:</span> <span className="font-semibold">{pendingZoneMove.fromZoneName || '—'}</span></div>
              <div><span className="text-slate-400">To:</span> <span className="font-semibold text-blue-700">{pendingZoneMove.toZoneName}</span></div>
            </div>
            <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setPendingZoneMove(null)}
                className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const m = pendingZoneMove;
                  setPendingZoneMove(null);
                  await m.execute();
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg"
              >
                Move task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task delete confirm — replaces the native browser confirm.
          Used by both single-row and bulk delete. Shows up to 5 task
          names so the user can sanity-check what they're about to
          remove; "+N more" suffix for bulk selections beyond that. */}
      {pendingTaskDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm"
          onClick={() => setPendingTaskDelete(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-[460px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {pendingTaskDelete.ids.length === 1
                    ? 'Delete this task?'
                    : `Delete ${pendingTaskDelete.ids.length} tasks?`}
                </h3>
                <p className="text-[13px] text-slate-500 mt-0.5">
                  This cannot be undone.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 text-[13px] text-slate-700 space-y-1.5 max-h-48 overflow-y-auto">
              {pendingTaskDelete.names.slice(0, 5).map((n, i) => (
                <div key={i} className="truncate" title={n}>
                  <span className="text-slate-400">•</span>{' '}
                  <span className="font-medium text-slate-800">{n}</span>
                </div>
              ))}
              {pendingTaskDelete.ids.length > 5 && (
                <div className="text-[12px] text-slate-500 pt-1">
                  +{pendingTaskDelete.ids.length - 5} more
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setPendingTaskDelete(null)}
                className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const m = pendingTaskDelete;
                  setPendingTaskDelete(null);
                  await m.execute();
                }}
                className="bg-red-600 hover:bg-red-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg"
              >
                {pendingTaskDelete.ids.length === 1
                  ? 'Delete task'
                  : `Delete ${pendingTaskDelete.ids.length} tasks`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project-level totals strip — sticky-ish summary at the top of the
          planning view. Same numbers that already appear inline near the
          task table, surfaced prominently so PMs see project-wide totals
          without scrolling. Updates live as filters/edits change. */}
      {!showTemplatePicker && !showManualZone && sorted.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 bg-gradient-to-br from-blue-50/40 to-white px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]">
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Tasks</div>
            <div className="text-[18px] font-bold text-slate-900 tabular-nums">{sorted.length}</div>
          </div>
          <span className="h-8 w-px bg-slate-200" />
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Budget hours</div>
            <div className="text-[18px] font-bold text-slate-900 tabular-nums">{totalHours}h</div>
          </div>
          <span className="h-8 w-px bg-slate-200" />
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Logged hours</div>
            <div className={cn(
              'text-[18px] font-bold tabular-nums',
              totalLoggedHours === 0 ? 'text-slate-400'
                : totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-600'
                : 'text-blue-600',
            )}>{totalLoggedHours}h</div>
          </div>
          <span className="h-8 w-px bg-slate-200" />
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Budget amount</div>
            <div className="text-[18px] font-bold text-slate-900 tabular-nums">₪{totalAmount.toLocaleString()}</div>
          </div>
          <span className="h-8 w-px bg-slate-200" />
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Progress</div>
            <div className="text-[18px] font-bold text-slate-900 tabular-nums">
              {totalHours > 0 ? `${Math.min(100, Math.round((totalLoggedHours / totalHours) * 100))}%` : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Action bar */}
      {!showTemplatePicker && !showManualZone && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowTemplatePicker(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Zone from Template
            </button>
            <button onClick={() => setShowManualZone(true)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Zone Manually
            </button>
            {/* Root-level adds — tasks/deliverables that attach to the
                project itself, not to any zone. Render in a "Project
                Root" group above the zone tree. */}
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <button onClick={() => setShowRootTemplate(true)} className="bg-violet-600 hover:bg-violet-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Deliverable
            </button>
            <button onClick={() => setShowRootTask(true)} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Task
            </button>
          </div>
          <div className="flex items-center gap-3">
            {sorted.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const visibleIds = sorted.map((t: any) => t.id);
                  const allSelected = visibleIds.every((id: number) => selectedTaskIds.has(id));
                  toggleManyTasks(visibleIds, !allSelected);
                }}
                className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                {sorted.every((t: any) => selectedTaskIds.has(t.id)) ? 'Deselect all' : `Select all (${sorted.length})`}
              </button>
            )}
            {undoCount > 0 && (
              <button
                type="button"
                onClick={handleUndo}
                className="text-[12px] font-semibold text-slate-500 hover:text-slate-700 flex items-center gap-1"
                title="Undo last action (Ctrl+Z)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M7.793 2.232a.75.75 0 01-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 010 10.75H10.75a.75.75 0 010-1.5h2.875a3.875 3.875 0 000-7.75H3.622l4.146 3.957a.75.75 0 01-1.036 1.085l-5.5-5.25a.75.75 0 010-1.085l5.5-5.25a.75.75 0 011.06.025z" clipRule="evenodd" /></svg>
                Undo
              </button>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-400">Group:</span>
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none">
                <option value="zone">Zone</option>
                <option value="service">Deliverable</option>
                <option value="phase">Service</option>
                <option value="none">No Grouping</option>
              </select>
            </div>
            {/* One-click collapse/expand for every card on the page —
                zones, hierarchical zones, project-root deliverables. */}
            <button
              type="button"
              onClick={toggleBulkCollapse}
              title={bulkCollapsed ? 'Expand all groups' : 'Collapse all groups'}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[12px] font-semibold text-slate-600 hover:bg-slate-50 hover:border-slate-300"
            >
              {bulkCollapsed
                ? <><ChevronsUpDown className="w-3.5 h-3.5" /> Expand all</>
                : <><ChevronsDownUp className="w-3.5 h-3.5" /> Collapse all</>}
            </button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks..." className="w-48 pl-8 px-2.5 py-1.5 rounded-lg border border-slate-200 text-[13px] text-slate-700 focus:border-blue-500 focus:outline-none" />
            </div>
          </div>
        </div>
      )}

      {/* Task filters — Status + Estimated Start range + Due Date range */}
      {!showTemplatePicker && !showManualZone && (
        <div className="flex flex-wrap items-center gap-2 -mt-2">
          <span className="text-[11px] font-semibold text-slate-400">Filter by:</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-2.5 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700 focus:border-blue-500 focus:outline-none"
            title="Status"
          >
            <option value="">All statuses</option>
            <option value="not_started">Not started</option>
            <option value="in_progress">In progress</option>
            <option value="in_review">In review</option>
            <option value="completed">Completed</option>
            <option value="on_hold">On hold</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <span>Est. start:</span>
            <input type="date" value={filterStartFrom} onChange={(e) => setFilterStartFrom(e.target.value)} className="px-1.5 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700" />
            <span className="text-slate-400">→</span>
            <input type="date" value={filterStartTo} onChange={(e) => setFilterStartTo(e.target.value)} className="px-1.5 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700" />
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <span>Due:</span>
            <input type="date" value={filterDueFrom} onChange={(e) => setFilterDueFrom(e.target.value)} className="px-1.5 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700" />
            <span className="text-slate-400">→</span>
            <input type="date" value={filterDueTo} onChange={(e) => setFilterDueTo(e.target.value)} className="px-1.5 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700" />
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <span>Has due date:</span>
            <select
              value={filterHasDue}
              onChange={(e) => setFilterHasDue(e.target.value as '' | 'yes' | 'no')}
              className="px-2 py-1 rounded-md border border-slate-200 text-[12px] text-slate-700 focus:border-blue-500 focus:outline-none"
              title="Filter tasks by whether they have a due date"
            >
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          {hasTaskFilter && (
            <button
              type="button"
              onClick={clearTaskFilters}
              className="text-[12px] text-slate-500 hover:text-slate-700 underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Task table — full width */}
      {sorted.length > 0 || flatZones.length > 0 ? (
        <div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Project Tasks</h3>
              <span className="text-[11px] font-medium text-slate-400">
                {sorted.length} tasks · {totalHours}h budget · <span className={cn('font-semibold', totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-500' : 'text-slate-500')}>{totalLoggedHours}h logged</span> · ₪{totalAmount.toLocaleString()}
              </span>
            </div>
            {/* Feasibility + Progress */}
            <FeasibilityBadge projectId={projectId} />
          </div>

          {/* Column header for non-zone grouping — matches ZoneGroup table */}

          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragStart={handleGlobalDragStart}
            onDragEnd={handleGlobalDragEnd}
          >
            {/* Two cooperating sortable surfaces inside this DndContext:
                  - ZONES: outer SortableContext lists "z-<id>" string ids.
                    SortableTopZone wraps each top-level HierarchicalZoneGroup
                    and registers its own useSortable on the same string id,
                    with the listeners attached to the zone-row drag handle.
                  - TASKS: each task's useSortable (inside SortableTaskList)
                    auto-registers globally with dnd-kit using the numeric
                    task id. We DON'T need an outer task-id SortableContext;
                    every task is already discoverable for collision detection
                    through its own useSortable hook. (An earlier attempt at
                    nesting an outer-task SortableContext caused regressions.)
                handleGlobalDragEnd switches on the active.id type to dispatch
                zone-reorder vs task-reorder. */}
            {groupBy === 'zone' ? (
              <>
                {/* Project Root section — tasks with zoneId=null. Rendered
                    only when there's at least one such task. The section
                    visually mimics a top-level zone but is read-only as
                    far as zone DnD is concerned (tasks here can be
                    reordered or moved into a zone, but the section
                    itself isn't draggable). */}
                <ProjectRootGroup
                  projectId={projectId}
                  tasks={sorted.filter((t: any) => t.zoneId == null)}
                  members={members}
                  onUpdate={invalidate}
                  onDeleteTask={(id: number) => requestTaskDelete(
  // If the trashed row is part of a multi-selection, treat the
  // click as a bulk delete (same spreadsheet pattern used for
  // other inline edits). Otherwise it's just this row.
  selectedTaskIds.has(id) && selectedTaskIds.size > 1
    ? Array.from(selectedTaskIds)
    : [id],
)}
                  selectedTaskIds={selectedTaskIds}
                  onToggleTask={toggleTask}
                  onToggleMany={toggleManyTasks}
                />
                <SortableContext
                  items={zones.filter((z: any) => !z.parentId).map((z: any) => `z-${z.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {zones.map((z: any) => (
                    <SortableZone key={z.id} zone={z} allTasks={sorted} members={members} projectId={projectId} depth={0}
                      onUpdate={invalidate} onDeleteTask={(id: number) => requestTaskDelete(
  // If the trashed row is part of a multi-selection, treat the
  // click as a bulk delete (same spreadsheet pattern used for
  // other inline edits). Otherwise it's just this row.
  selectedTaskIds.has(id) && selectedTaskIds.size > 1
    ? Array.from(selectedTaskIds)
    : [id],
)}
                      onDeleteZone={(id: number) => deleteZone.mutate(id)} onDuplicateZone={(id: number, name: string) => duplicateZone.mutate({ id, name })}
                      thClass={thClass} handleSort={handleSort} sortIcon={sortIcon}
                      selectedTaskIds={selectedTaskIds} onToggleTask={toggleTask} onToggleMany={toggleManyTasks} />
                  ))}
                </SortableContext>
              </>
            ) : (
              // Non-zone groupings (Deliverable / Service / None) — render
              // each group with the same deliverable-card visual language
              // used for the project root, so the design stays consistent
              // when the user flips the groupBy dropdown. Each card gets
              // its entity's accent colour and is draggable via the grip
              // handle on hover; drag-and-drop reorder writes back to
              // ServiceType.sortOrder or Phase.sortOrder.
              <SortableContext
                items={groups.filter((g: any) => g.dndId).map((g: any) => g.dndId)}
                strategy={verticalListSortingStrategy}
              >
                {groups.map((g: any) => (
                  <ProjectRootDeliverableGroup
                    key={g.key}
                    projectId={projectId}
                    label={g.label}
                    serviceLabel={g.serviceLabel}
                    color={g.color}
                    tasks={g.tasks}
                    members={members}
                    onUpdate={invalidate}
                    onDeleteTask={(id: number) => requestTaskDelete(
  // If the trashed row is part of a multi-selection, treat the
  // click as a bulk delete (same spreadsheet pattern used for
  // other inline edits). Otherwise it's just this row.
  selectedTaskIds.has(id) && selectedTaskIds.size > 1
    ? Array.from(selectedTaskIds)
    : [id],
)}
                    selectedTaskIds={selectedTaskIds}
                    onToggleTask={toggleTask}
                    onToggleMany={toggleManyTasks}
                    dndId={g.dndId}
                  />
                ))}
              </SortableContext>
            )}
            {activeDragId != null && (
              <DragOverlay>
                <div className="flex items-center gap-3 py-2 px-4 bg-white border border-blue-300 shadow-xl rounded-lg text-[13px] opacity-90">
                  <GripVertical className="w-3.5 h-3.5 text-blue-500" />
                  <span className="font-medium text-slate-900">
                    {(() => {
                      // Identify the dragged item to render a useful preview.
                      // Order matters: deliverable strings start with "d-",
                      // zones with "z-", tasks are numeric.
                      const aid = activeDragId as any;
                      if (typeof aid === 'string' && aid.startsWith('d-st-')) {
                        const id = Number(aid.slice(5));
                        const t = tasks.find((x: any) => x.serviceTypeId === id);
                        return t?.serviceType?.name || 'Deliverable';
                      }
                      if (typeof aid === 'string' && aid.startsWith('d-ph-')) {
                        const id = Number(aid.slice(5));
                        const t = tasks.find((x: any) => x.phaseId === id);
                        return t?.phase?.name || 'Deliverable';
                      }
                      if (typeof aid === 'string' && aid.startsWith('z-')) {
                        return zones.find((z: any) => z.id === Number(aid.slice(2)))?.name || 'Zone';
                      }
                      return tasks.find((t: any) => t.id === activeDragId)?.name || 'Task';
                    })()}
                  </span>
                </div>
              </DragOverlay>
            )}
          </DndContext>

          <div className="flex items-center gap-6 px-4 py-2.5 border-t border-slate-200 bg-[#FAFBFC] text-[12px]">
            <div><span className="text-slate-400">Total:</span> <span className="font-mono text-xs font-semibold text-slate-900 ml-1">{sorted.length} tasks · {totalHours}h · ₪{totalAmount.toLocaleString()}</span></div>
            {totalLoggedHours > 0 && (
              <>
                <span className="text-slate-300">│</span>
                <div><span className="text-slate-400">Logged:</span> <span className={cn('font-mono text-xs font-semibold ml-1', totalLoggedHours > totalHours && totalHours > 0 ? 'text-red-600' : 'text-blue-600')}>{totalLoggedHours}h</span>{totalHours > 0 && <span className="text-slate-400 ml-1">/ {totalHours}h ({Math.round(totalLoggedHours / totalHours * 100)}%)</span>}</div>
              </>
            )}
            {budget?.projectBudget > 0 && (
              <>
                <span className="text-slate-300">│</span>
                <div><span className="text-slate-400">Budget:</span> <span className="font-mono text-xs font-semibold text-slate-900 ml-1">₪{Number(budget.projectBudget).toLocaleString()}</span></div>
                <div><span className="text-slate-400">Remaining:</span> <span className={cn('font-mono text-xs font-semibold ml-1', budget.remaining >= 0 ? 'text-emerald-600' : 'text-red-600')}>₪{Number(budget.remaining).toLocaleString()}</span></div>
                <div className="flex-1 max-w-[200px]"><div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full transition-all duration-400" style={{ width: `${Math.min(100, 100 - (budget.remainingPct || 0))}%` }} /></div></div>
              </>
            )}
          </div>
        </div>
      ) : !showTemplatePicker && !showManualZone ? (
        <div className="bg-white rounded-[14px] border border-slate-200 p-12 text-center">
          <p className="text-[15px] font-bold text-slate-900 mb-2">No zones or tasks yet</p>
          <p className="text-[13px] text-slate-400 mb-4">Start by adding a zone from a template or create one manually</p>
        </div>
      ) : null}

      {/* Floating bulk action bar (only visible when tasks are selected) */}
      <BulkActionBar
        selectedCount={selectedTaskIds.size}
        selectedTaskIds={selectedTaskIds}
        members={members}
        projectId={projectId}
        onClear={clearSelection}
        onRequestDelete={requestTaskDelete}
      />
    </div>
    </BulkCollapseContext.Provider>
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function PlanningPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  return (
    <div className="px-4 py-5 space-y-4">
      <button onClick={() => navigate(`/projects/${Number(id)}`)} className="flex items-center gap-1.5 text-[13px] text-slate-400 hover:text-slate-600"><ArrowLeft className="h-4 w-4" /> Back to Project</button>
      <PlanningView projectId={Number(id)} />
    </div>
  );
}

export function PlanningTab({ projectId }: { projectId: number }) {
  return <PlanningView projectId={projectId} />;
}

export default PlanningPage;
