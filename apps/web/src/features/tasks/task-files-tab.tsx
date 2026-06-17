import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2, Download, FileText } from 'lucide-react';
import { tasksApi } from '@/api/tasks.api';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { UserAvatar } from '@/components/shared/user-avatar';

/**
 * Task-scoped files view inside the task drawer. Uploads here create a
 * TaskAttachment row tied to THIS task (folder='tasks' on the upload),
 * which then surfaces under "TASK FILES" → "<task name>" group in the
 * project Files tab. The previous version embedded the PROJECT FilesTab
 * here, which silently routed uploads to ProjectFile — so files vanished
 * from any per-task view.
 */
interface TaskAttachment {
  id: number;
  fileName: string;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  uploader?: { id: number; firstName: string; lastName: string };
}

function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(+d)) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function TaskFilesTab({ taskId }: { taskId: number }) {
  const qc = useQueryClient();
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('tasks', 'write');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: attachments = [], isLoading } = useQuery<TaskAttachment[]>({
    queryKey: ['task-attachments', taskId],
    queryFn: () => tasksApi.getAttachments(taskId).then((r: any) => r?.data ?? r ?? []),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task-attachments', taskId] });
    // Also bust the project Files tab cache so the new attachment shows
    // up under TASK FILES → <this task> the next time the user opens it.
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const remove = useMutation({
    mutationFn: (attachmentId: number) => tasksApi.removeAttachment(attachmentId),
    onSuccess: () => {
      invalidate();
      notify.success('File removed', { code: 'TASK-FILE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove file'),
  });

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        // 1. Upload to /files/upload → URL on disk
        const uploaded: any = await tasksApi.uploadFile(file, 'tasks');
        // 2. Create the TaskAttachment row pointing at the URL
        await tasksApi.addAttachment(taskId, {
          fileName: file.name,
          fileUrl: uploaded.url,
          fileSize: file.size,
          mimeType: file.type || undefined,
        });
      }
      invalidate();
      notify.success(
        files.length === 1 ? 'File attached' : `${files.length} files attached`,
        { code: 'TASK-FILE-UPLOAD-200' },
      );
    } catch (err: any) {
      notify.apiError(err, 'Failed to upload file');
    } finally {
      setUploading(false);
      if (e.target.value) e.target.value = '';
    }
  };

  const handleDownload = (att: TaskAttachment) => {
    // Task attachments are stored as URLs returned by /files/upload — they
    // live under /uploads/* on the API host. Opening in a new tab lets the
    // browser stream the file with its own cookie-auth header attached.
    if (att.fileUrl) window.open(att.fileUrl, '_blank', 'noopener');
  };

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">Task Files</h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Files attached to this task — they also appear under{' '}
            <span className="font-medium">Project → Files → Task Files</span>.
          </p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" multiple onChange={handleFilePick} className="hidden" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[12px] font-semibold px-3 py-1.5 rounded-md flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? 'Uploading…' : 'Upload File'}
            </button>
          </div>
        )}
      </header>

      {isLoading ? (
        <div className="rounded-md border border-slate-200 bg-white py-10 text-center text-[12px] text-slate-400">
          Loading files…
        </div>
      ) : attachments.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/40 py-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-2 text-[12px] font-medium text-slate-600">No files attached yet</p>
          {canWrite && (
            <p className="text-[11px] text-slate-400 mt-0.5">Upload one to share with the team.</p>
          )}
        </div>
      ) : (
        <ul className="rounded-md border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
          {attachments.map((att) => (
            <li key={att.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50/40">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700">
                <FileText className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => handleDownload(att)}
                  className="font-medium text-slate-800 hover:text-blue-600 hover:underline truncate block text-left text-[13px]"
                  title={`Download ${att.fileName}`}
                >
                  {att.fileName}
                </button>
                <p className="text-[10.5px] text-slate-500 mt-0.5">
                  {formatBytes(att.fileSize)}
                  {att.mimeType ? ` · ${att.mimeType}` : ''}
                  {' · '}
                  {formatDate(att.createdAt)}
                </p>
              </div>
              {att.uploader && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <UserAvatar
                    firstName={att.uploader.firstName}
                    lastName={att.uploader.lastName}
                    avatarUrl={null}
                    size="sm"
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => handleDownload(att)}
                className="shrink-0 p-1.5 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="Download / open"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Remove "${att.fileName}"?`)) remove.mutate(att.id);
                  }}
                  className="shrink-0 p-1.5 rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
