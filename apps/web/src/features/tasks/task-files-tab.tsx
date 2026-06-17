import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2, Download, FileText, FolderOpen, ExternalLink, Link as LinkIcon, Star } from 'lucide-react';
import { NavLinkWithReturn } from '@/components/nav/return-route';
import { tasksApi } from '@/api/tasks.api';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { UserAvatar } from '@/components/shared/user-avatar';
import { useProjectFileFavorites } from '@/features/projects/use-project-file-favorites';
import { cn } from '@/lib/utils';

/**
 * Task-scoped files view inside the task drawer. Two panels:
 *   1. THIS TASK'S FILES — TaskAttachment rows for the open task.
 *      Editable: upload, delete.
 *   2. PROJECT FILES — read-only context of the parent project's
 *      directly-attached files (ProjectFile rows). Helpful so the
 *      assignee sees the briefs/templates/etc. attached to the project
 *      without leaving the drawer. To manage them, click through to the
 *      project Files tab via the header link.
 *
 * Uploads always create a TaskAttachment for THIS task — never a
 * ProjectFile. Comment-level attachments live in the Discussion tab and
 * are filtered out of both panels here.
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

interface ProjectFile {
  id: string;
  rawId: number;
  source: 'project' | 'task';
  taskId?: number;
  taskName?: string | null;
  kind: 'upload' | 'link';
  name: string;
  url: string;
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

export function TaskFilesTab({
  taskId,
  projectId,
  backLabel,
}: {
  taskId: number;
  projectId?: number;
  /** Label for the destination's "← Back to {x}" pill. */
  backLabel?: string;
}) {
  const qc = useQueryClient();
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('tasks', 'write');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: attachments = [], isLoading } = useQuery<TaskAttachment[]>({
    queryKey: ['task-attachments', taskId],
    queryFn: () => tasksApi.getAttachments(taskId).then((r: any) => r?.data ?? r ?? []),
  });

  // Project files for context — only the ones DIRECTLY attached to the
  // project (source='project'), so we don't double-list other tasks'
  // attachments in the bottom panel. Cached for 60s so toggling between
  // sibling tasks in the same project doesn't refetch.
  const { data: projectFilesRaw = [] } = useQuery<ProjectFile[]>({
    queryKey: ['projects', projectId, 'files'],
    enabled: projectId != null,
    queryFn: () =>
      client.get(`/projects/${projectId}/files`).then((r) => r.data?.data ?? r.data),
    staleTime: 60_000,
  });
  // Favorites are shared with the project Files tab (same localStorage key
  // per project), so a star pinned in either place shows up in the other.
  // Pinned files float to the top of the panel.
  const { favorites, toggleFavorite } = useProjectFileFavorites(projectId ?? 0);
  const projectFiles = projectFilesRaw
    .filter((f) => f.source === 'project')
    .slice()
    .sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0));

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
    <div className="space-y-5">
      {/* Project files panel FIRST — context the assignee needs before
          they look at their own task files. Read-only here; click
          "Manage →" to add/remove project-level files. */}
      {projectId != null && (
        <section className="rounded-md border border-slate-200 bg-slate-50/40 overflow-hidden">
          <header className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-slate-100/60">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Project Files</span>
              <span className="text-[10px] font-semibold rounded-full bg-slate-200 text-slate-700 px-1.5 py-0.5">
                {projectFiles.length}
              </span>
            </div>
            <NavLinkWithReturn
              to={`/projects/${projectId}?tab=files`}
              returnLabel={backLabel ?? `task #${taskId}`}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700"
              title="Open the project's Files tab to upload or manage"
            >
              Manage <ExternalLink className="h-3 w-3" />
            </NavLinkWithReturn>
          </header>
          {projectFiles.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-slate-400 italic">
              No project-level files yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200/60">
              {projectFiles.map((f) => {
                const isFav = favorites.has(f.id);
                return (
                <li
                  key={f.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 hover:bg-white/60',
                    isFav && 'bg-yellow-50/40',
                  )}
                >
                  {/* Star toggles the shared per-project favorite set —
                      same localStorage key as the project Files tab, so
                      pinning here surfaces it there and vice-versa. */}
                  <button
                    type="button"
                    onClick={() => toggleFavorite(f.id)}
                    className={cn(
                      'shrink-0 p-1 rounded transition-colors',
                      isFav ? 'text-yellow-500 hover:text-yellow-600' : 'text-slate-300 hover:text-yellow-500',
                    )}
                    title={isFav ? 'Unpin from top' : 'Pin to top'}
                    aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <Star className={cn('h-3.5 w-3.5', isFav && 'fill-yellow-500')} />
                  </button>
                  <div className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                    f.kind === 'upload'
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-violet-50 text-violet-700 border-violet-200',
                  )}>
                    {f.kind === 'upload' ? <FileText className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <a
                      href={f.kind === 'link' ? f.url : `/api/v1/projects/${projectId}/files/${f.rawId}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={f.url}
                      className="font-medium text-slate-700 hover:text-blue-600 hover:underline truncate block text-[12px]"
                    >
                      {f.name}
                    </a>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {f.kind === 'upload' ? formatBytes(f.fileSize) : 'Link'}
                      {' · '}{formatDate(f.createdAt)}
                    </p>
                  </div>
                  {f.uploader && (
                    <UserAvatar
                      firstName={f.uploader.firstName}
                      lastName={f.uploader.lastName}
                      avatarUrl={null}
                      size="sm"
                    />
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* THIS TASK'S FILES — second panel, with the upload action. Kept
          below so the user reads "project → my task" top-down. */}
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">This Task's Files</h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Attached to this task — also visible under{' '}
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
