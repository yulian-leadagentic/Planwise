import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText, Link as LinkIcon, Upload, Trash2, Download, Copy, Check, Plus, ExternalLink, X, HardDrive, Star,
} from 'lucide-react';

// Recognise common cloud-storage URLs so we can show a friendlier icon /
// label instead of a generic "Link" pill. Pure heuristics — host-only.
type LinkProvider = 'google-drive' | 'dropbox' | 'onedrive' | 'sharepoint' | 'generic';
function detectLinkProvider(url: string): LinkProvider {
  if (!url) return 'generic';
  const u = url.toLowerCase();
  if (u.includes('drive.google.com') || u.includes('docs.google.com') || u.includes('sheets.google.com') || u.includes('slides.google.com')) return 'google-drive';
  if (u.includes('dropbox.com')) return 'dropbox';
  if (u.includes('1drv.ms') || u.includes('onedrive.live.com')) return 'onedrive';
  if (u.includes('sharepoint.com')) return 'sharepoint';
  return 'generic';
}
const PROVIDER_LABEL: Record<LinkProvider, string> = {
  'google-drive': 'Google Drive',
  'dropbox': 'Dropbox',
  'onedrive': 'OneDrive',
  'sharepoint': 'SharePoint',
  'generic': 'Link',
};
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/shared/user-avatar';

interface ProjectFile {
  /** Namespaced id from the API: `p-<n>` for ProjectFile, `t-<n>` for TaskAttachment. */
  id: string;
  rawId: number;
  /** Where the file came from. Drives the Source badge + which API endpoint
   *  the delete/download calls hit. */
  source: 'project' | 'task';
  /** Present only for source='task' — the task this attachment lives under.
   *  Used to render a clickable badge that opens the task drawer. */
  taskId?: number;
  taskName?: string | null;
  kind: 'upload' | 'link';
  name: string;
  url: string;
  fileSize: number | null;
  mimeType: string | null;
  description: string | null;
  createdAt: string;
  uploader?: { id: number; firstName: string; lastName: string; avatarUrl: string | null };
}

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 focus:border-blue-500 focus:outline-none';

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function formatUploadDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(+d)) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Per-project + per-user favorite-file set, persisted to localStorage.
 * Server-side persistence is a follow-up task; for now this gives users
 * the "pin to top" behaviour without a schema migration. Keyed by project
 * so favorites don't bleed between projects.
 */
function useFavorites(projectId: number) {
  const storageKey = `planwise:project-${projectId}:favorite-files`;
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const toggleFavorite = (fileId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // localStorage full / disabled — fail silently, the in-memory state still works
      }
      return next;
    });
  };
  return { favorites, toggleFavorite };
}

export function FilesTab({ projectId }: { projectId: number }) {
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('projects/files', 'write');
  const canDelete = isAdmin || can('projects/files', 'delete');
  const queryClient = useQueryClient();
  const [showAddLink, setShowAddLink] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: files = [], isLoading } = useQuery<ProjectFile[]>({
    queryKey: ['projects', projectId, 'files'],
    queryFn: () => client.get(`/projects/${projectId}/files`).then((r) => r.data?.data ?? r.data),
  });

  // Favorites: pinned to top of EACH section list. Persisted locally per
  // project (see useFavorites — server-side persistence is a planned follow-up).
  const { favorites, toggleFavorite } = useFavorites(projectId);
  const sortBySource = (a: ProjectFile, b: ProjectFile) => {
    const aFav = favorites.has(a.id) ? 1 : 0;
    const bFav = favorites.has(b.id) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  };
  // Split into two sections: directly-attached project files and files
  // uploaded to specific tasks. Each section is independently sorted.
  const projectFiles = files.filter((f) => f.source === 'project').sort(sortBySource);
  const taskFiles = files.filter((f) => f.source === 'task').sort(sortBySource);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return client
        .post(`/projects/${projectId}/files/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        .then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      notify.success('File uploaded', { code: 'PROJ-FILE-UPLOAD-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to upload file'),
  });

  // Delete dispatches by source. Project files use the existing per-project
  // endpoint; task attachments use the global /tasks/attachments/:id route.
  // Either way the list invalidates and the row vanishes from this view.
  const remove = useMutation({
    mutationFn: async (file: ProjectFile) => {
      if (file.source === 'task') {
        return client.delete(`/tasks/attachments/${file.rawId}`).then((r) => r.data);
      }
      return client.delete(`/projects/${projectId}/files/${file.rawId}`).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      notify.success('File removed', { code: 'PROJ-FILE-DELETE-200' });
    },
    onError: (err: any) => notify.apiError(err, 'Failed to remove file'),
  });

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    if (e.target.value) e.target.value = '';
  };

  const handleCopy = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      notify.error('Could not copy to clipboard', { code: 'CLIPBOARD-500' });
    }
  };

  const handleDownload = async (file: ProjectFile) => {
    try {
      if (file.source === 'task') {
        // Task attachments are stored as plain URLs (fileUrl) — open in a
        // new tab. They live under the same /uploads/* path the backend
        // serves, so authentication via cookie carries through.
        if (file.url) window.open(file.url, '_blank', 'noopener');
        return;
      }
      const res = await client.get(`/projects/${projectId}/files/${file.rawId}/download`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: file.mimeType || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      notify.apiError(err, 'Failed to download file');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-slate-900">Project Files</h3>
          <p className="text-[12px] text-slate-500 mt-0.5">
            Upload documents or link to files on a network share or shared drive
          </p>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" onChange={handleFilePick} className="hidden" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
              className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending ? 'Uploading...' : 'Upload File'}
            </button>
            <button
              type="button"
              onClick={() => setShowAddLink(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Link
            </button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading files...</div>
      ) : files.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-slate-200 bg-slate-50/40 p-10 text-center">
          <FileText className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-600">No files yet</p>
          <p className="text-[12px] text-slate-400 mt-1">
            {canWrite ? 'Upload a file or paste a link to a shared location' : 'Files will appear here once added'}
          </p>
        </div>
      ) : (
        <FilesSections
          projectFiles={projectFiles}
          taskFiles={taskFiles}
          favorites={favorites}
          toggleFavorite={toggleFavorite}
          handleDownload={handleDownload}
          handleCopy={handleCopy}
          copiedId={copiedId}
          canDelete={canDelete}
          onRemove={(f) => { if (confirm(`Remove "${f.name}"?`)) remove.mutate(f); }}
        />
      )}

      {showAddLink && (
        <AddLinkModal
          projectId={projectId}
          onClose={() => setShowAddLink(false)}
        />
      )}
    </div>
  );
}

/**
 * Renders two clearly separated panels — Project Files and Task Files —
 * each with its own header, count, and table. Empty section gets a thin
 * placeholder so the layout reads as "two boxes" even when one is empty,
 * which is what the customer asked for: a visible separation between
 * project-attached files and task-attached files.
 */
function FilesSections({
  projectFiles,
  taskFiles,
  favorites,
  toggleFavorite,
  handleDownload,
  handleCopy,
  copiedId,
  canDelete,
  onRemove,
}: {
  projectFiles: ProjectFile[];
  taskFiles: ProjectFile[];
  favorites: Set<string>;
  toggleFavorite: (id: string) => void;
  handleDownload: (file: ProjectFile) => void;
  handleCopy: (id: string, url: string) => void;
  copiedId: string | null;
  canDelete: boolean;
  onRemove: (file: ProjectFile) => void;
}) {
  return (
    <div className="space-y-6">
      <SectionPanel
        title="Project Files"
        subtitle="Files attached directly to the project"
        count={projectFiles.length}
        accent="slate"
        files={projectFiles}
        emptyHint="No project-level files yet. Upload one above or paste a link."
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        handleDownload={handleDownload}
        handleCopy={handleCopy}
        copiedId={copiedId}
        canDelete={canDelete}
        onRemove={onRemove}
      />
      <SectionPanel
        title="Task Files"
        subtitle="Files attached to individual tasks in this project"
        count={taskFiles.length}
        accent="indigo"
        files={taskFiles}
        groupByTask
        emptyHint="No task attachments yet. They appear here when someone adds a file from a task drawer."
        favorites={favorites}
        toggleFavorite={toggleFavorite}
        handleDownload={handleDownload}
        handleCopy={handleCopy}
        copiedId={copiedId}
        canDelete={canDelete}
        onRemove={onRemove}
      />
    </div>
  );
}

function SectionPanel({
  title,
  subtitle,
  count,
  accent,
  files,
  emptyHint,
  groupByTask,
  favorites,
  toggleFavorite,
  handleDownload,
  handleCopy,
  copiedId,
  canDelete,
  onRemove,
}: {
  title: string;
  subtitle: string;
  count: number;
  accent: 'slate' | 'indigo';
  files: ProjectFile[];
  emptyHint: string;
  groupByTask?: boolean;
  favorites: Set<string>;
  toggleFavorite: (id: string) => void;
  handleDownload: (file: ProjectFile) => void;
  handleCopy: (id: string, url: string) => void;
  copiedId: string | null;
  canDelete: boolean;
  onRemove: (file: ProjectFile) => void;
}) {
  // When the Task section is grouped, build a [taskName, taskFiles[]] list,
  // ordered by the first appearance of each task (which is already
  // newest-first because the parent sort is createdAt desc). Within each
  // task the favorites bubble to the top via the parent sort.
  const grouped: Array<{ key: string; label: string; rows: ProjectFile[] }> = [];
  if (groupByTask) {
    const map = new Map<string, ProjectFile[]>();
    for (const f of files) {
      const key = `${f.taskId ?? 0}|${f.taskName ?? ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    for (const [key, rows] of map.entries()) {
      const label = rows[0]?.taskName ?? `Task #${rows[0]?.taskId ?? '?'}`;
      grouped.push({ key, label, rows });
    }
  }

  return (
    <section className={cn(
      'rounded-[14px] border bg-white overflow-hidden',
      accent === 'indigo' ? 'border-indigo-100' : 'border-slate-200',
    )}>
      <header className={cn(
        'flex items-baseline justify-between gap-3 px-5 py-3 border-b',
        accent === 'indigo' ? 'bg-indigo-50/50 border-indigo-100' : 'bg-slate-50 border-slate-200',
      )}>
        <div>
          <h4 className={cn(
            'text-[13px] font-bold uppercase tracking-wider',
            accent === 'indigo' ? 'text-indigo-700' : 'text-slate-700',
          )}>
            {title}
            <span className={cn(
              'ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
              accent === 'indigo' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-700',
            )}>
              {count}
            </span>
          </h4>
          <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
        </div>
      </header>
      {files.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-slate-400 italic">
          {emptyHint}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50/60 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-2 py-2 text-center font-semibold w-10"></th>
                <th className="px-4 py-2 text-left font-semibold">Name</th>
                <th className="px-4 py-2 text-left font-semibold w-32">Type</th>
                <th className="px-4 py-2 text-left font-semibold w-40">Added by</th>
                <th className="px-4 py-2 text-left font-semibold w-32">Uploaded</th>
                <th className="px-4 py-2 text-right font-semibold w-32"></th>
              </tr>
            </thead>
            <tbody>
              {groupByTask ? (
                grouped.map((g) => (
                  <FileGroupRows
                    key={g.key}
                    label={g.label}
                    rows={g.rows}
                    favorites={favorites}
                    toggleFavorite={toggleFavorite}
                    handleDownload={handleDownload}
                    handleCopy={handleCopy}
                    copiedId={copiedId}
                    canDelete={canDelete}
                    onRemove={onRemove}
                  />
                ))
              ) : (
                files.map((f) => (
                  <FileRow
                    key={f.id}
                    f={f}
                    favorites={favorites}
                    toggleFavorite={toggleFavorite}
                    handleDownload={handleDownload}
                    handleCopy={handleCopy}
                    copiedId={copiedId}
                    canDelete={canDelete}
                    onRemove={onRemove}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FileGroupRows({
  label,
  rows,
  ...rest
}: {
  label: string;
  rows: ProjectFile[];
  favorites: Set<string>;
  toggleFavorite: (id: string) => void;
  handleDownload: (file: ProjectFile) => void;
  handleCopy: (id: string, url: string) => void;
  copiedId: string | null;
  canDelete: boolean;
  onRemove: (file: ProjectFile) => void;
}) {
  // Sub-header row per task, then the files underneath it. The label is
  // not a button to keep this list compact; clicking the task name on the
  // file row chip in the future would open the drawer.
  return (
    <>
      <tr className="bg-indigo-50/40">
        <td colSpan={6} className="px-4 py-2 text-[12px] font-semibold text-indigo-800">
          {label} <span className="font-normal text-indigo-600">({rows.length})</span>
        </td>
      </tr>
      {rows.map((f) => (
        <FileRow key={f.id} f={f} {...rest} />
      ))}
    </>
  );
}

function FileRow({
  f,
  favorites,
  toggleFavorite,
  handleDownload,
  handleCopy,
  copiedId,
  canDelete,
  onRemove,
}: {
  f: ProjectFile;
  favorites: Set<string>;
  toggleFavorite: (id: string) => void;
  handleDownload: (file: ProjectFile) => void;
  handleCopy: (id: string, url: string) => void;
  copiedId: string | null;
  canDelete: boolean;
  onRemove: (file: ProjectFile) => void;
}) {
  const provider: LinkProvider = f.kind === 'link' ? detectLinkProvider(f.url) : 'generic';
  const isCloudLink = provider !== 'generic';
  const isFavorite = favorites.has(f.id);
  const openable = f.kind === 'link' && isHttpUrl(f.url);
  return (
    <tr className={cn(
      'border-t border-slate-100 hover:bg-slate-50/40',
      isFavorite && 'bg-yellow-50/30',
    )}>
      <td className="px-2 py-3 text-center">
        <button
          onClick={() => toggleFavorite(f.id)}
          className={cn(
            'p-1 rounded transition-colors',
            isFavorite ? 'text-yellow-500 hover:text-yellow-600' : 'text-slate-300 hover:text-yellow-500',
          )}
          title={isFavorite ? 'Unpin from top' : 'Pin to top'}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={cn('h-4 w-4', isFavorite && 'fill-yellow-500')} />
        </button>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-sm border',
            f.kind === 'upload' ? 'bg-blue-100 text-blue-700 border-blue-200'
              : provider === 'google-drive' ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
              : 'bg-violet-100 text-violet-700 border-violet-200',
          )}>
            {f.kind === 'upload' ? <FileText className="h-5 w-5" /> :
              isCloudLink ? <HardDrive className="h-5 w-5" /> :
              <LinkIcon className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            {openable ? (
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                title={f.url}
                className="font-medium text-slate-800 hover:text-blue-600 hover:underline truncate block"
              >
                {f.name}
              </a>
            ) : f.kind === 'upload' ? (
              <button
                type="button"
                onClick={() => handleDownload(f)}
                title={`Download ${f.name}`}
                className="font-medium text-slate-800 hover:text-blue-600 hover:underline truncate block text-left"
              >
                {f.name}
              </button>
            ) : (
              <p className="font-medium text-slate-800 truncate" title={f.url}>{f.name}</p>
            )}
            {f.kind === 'upload' && (
              <p className="text-[11px] text-slate-500 mt-0.5">
                {formatBytes(f.fileSize)}
                {f.mimeType ? ` · ${f.mimeType}` : ''}
              </p>
            )}
            {f.description && (
              <p className="text-[12px] text-slate-600 mt-1">{f.description}</p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[11px] font-semibold',
          f.kind === 'upload' ? 'bg-blue-50 text-blue-700'
            : provider === 'google-drive' ? 'bg-yellow-50 text-yellow-700'
            : 'bg-violet-50 text-violet-700',
        )}>
          {f.kind === 'upload' ? 'Upload' : PROVIDER_LABEL[provider]}
        </span>
      </td>
      <td className="px-4 py-3">
        {f.uploader && (
          <div className="flex items-center gap-2">
            <UserAvatar firstName={f.uploader.firstName} lastName={f.uploader.lastName} avatarUrl={f.uploader.avatarUrl} size="sm" />
            <span className="text-[12px] text-slate-700">{f.uploader.firstName} {f.uploader.lastName}</span>
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-[12px] text-slate-600">
        {formatUploadDate(f.createdAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {f.kind === 'upload' ? (
            <button
              onClick={() => handleDownload(f)}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          ) : (
            <>
              {isHttpUrl(f.url) && (
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
                  title="Open link"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button
                onClick={() => handleCopy(f.id, f.url)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
                title="Copy path"
              >
                {copiedId === f.id ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </>
          )}
          {canDelete && (
            <button
              onClick={() => onRemove(f)}
              className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}


function AddLinkModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);

  const create = useMutation({
    mutationFn: () => client.post(`/projects/${projectId}/files/link`, {
      name: name.trim(),
      url: url.trim(),
      description: description.trim() || undefined,
    }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
      notify.success('Link added', { code: 'PROJ-FILE-LINK-200' });
      onClose();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add link'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) {
      notify.warning('Name and path are required', { code: 'PROJ-FILE-LINK-400' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-[480px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-base font-bold text-slate-900">Add File Link</h2>
          <button onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-[12px] text-slate-500">
            Reference a file on a shared drive, network location, or cloud service. Examples:
            <span className="font-mono"> \\server\share\file.docx</span>,
            <span className="font-mono"> https://drive.google.com/file/d/...</span>,
            <span className="font-mono"> https://example.com/doc.pdf</span>,
            <span className="font-mono"> file:///C:/Path/file.pdf</span>
          </p>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Display Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Site Plan v2"
              className={inputClass}
            />
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Path / URL *</label>
            <div className="flex items-stretch gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/...   or   \\server\share\file.docx"
                className={cn(inputClass, 'font-mono text-[12px] flex-1')}
              />
              {/* Native file picker — browsers strip the full path for security
                  reasons (we get only the file name). The button is a UX
                  shortcut: it auto-fills the file name as a starting point,
                  with a hint to prepend the share / folder prefix. */}
              <label
                className="rounded-lg border border-slate-200 bg-white hover:border-slate-400 text-slate-700 text-[12px] font-semibold px-3 py-2 cursor-pointer flex items-center gap-1.5 shrink-0"
                title="Browser security limits us to the file's name — append your share/folder prefix manually."
              >
                <HardDrive className="h-3.5 w-3.5" />
                Browse…
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    // Browsers expose only the file name (not the full path)
                    // for security. Pre-fill it so the user has a starting
                    // point and just needs to add the directory prefix.
                    setUrl(file.name);
                    // If the display name is empty, also prefill it from the
                    // file name (without extension) — saves one more keystroke.
                    if (!name.trim()) {
                      const base = file.name.replace(/\.[^.]+$/, '');
                      setName(base);
                    }
                    // Reset the input so picking the same file again still fires.
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Browsers can't read the full file path for security — paste the network share or URL,
              or use <strong>Browse…</strong> to grab the file name and prepend the prefix manually
              (e.g. <span className="font-mono">\\server\share\</span>).
            </p>
            {url.trim() && (() => {
              const provider = detectLinkProvider(url.trim());
              if (provider === 'generic') return null;
              return (
                <p className="mt-1 text-[11px] text-slate-500 flex items-center gap-1">
                  <HardDrive className="h-3 w-3" /> Detected as <span className="font-semibold">{PROVIDER_LABEL[provider]}</span>
                </p>
              );
            })()}
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Notes (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={cn(inputClass, 'resize-none')}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg">Cancel</button>
            <button type="submit" disabled={create.isPending} className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50">
              {create.isPending ? 'Adding...' : 'Add Link'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
