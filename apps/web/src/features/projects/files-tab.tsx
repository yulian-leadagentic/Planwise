import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText, Link as LinkIcon, Upload, Trash2, Download, Copy, Check, Plus, ExternalLink, X, HardDrive,
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
  id: number;
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

export function FilesTab({ projectId }: { projectId: number }) {
  const { can, isAdmin } = usePermissions();
  const canWrite = isAdmin || can('projects/files', 'write');
  const canDelete = isAdmin || can('projects/files', 'delete');
  const queryClient = useQueryClient();
  const [showAddLink, setShowAddLink] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: files = [], isLoading } = useQuery<ProjectFile[]>({
    queryKey: ['projects', projectId, 'files'],
    queryFn: () => client.get(`/projects/${projectId}/files`).then((r) => r.data?.data ?? r.data),
  });

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

  const remove = useMutation({
    mutationFn: (fileId: number) => client.delete(`/projects/${projectId}/files/${fileId}`).then((r) => r.data),
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

  const handleCopy = async (id: number, url: string) => {
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
      const res = await client.get(`/projects/${projectId}/files/${file.id}/download`, { responseType: 'blob' });
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
        <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-2 text-left font-semibold">Name</th>
                <th className="px-4 py-2 text-left font-semibold w-32">Type</th>
                <th className="px-4 py-2 text-left font-semibold w-40">Added by</th>
                <th className="px-4 py-2 text-right font-semibold w-44"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const provider: LinkProvider = f.kind === 'link' ? detectLinkProvider(f.url) : 'generic';
                const isCloudLink = provider !== 'generic';
                return (
                <tr key={f.id} className="border-t border-slate-100 hover:bg-slate-50/40">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                        f.kind === 'upload' ? 'bg-blue-50 text-blue-600'
                          : provider === 'google-drive' ? 'bg-yellow-50 text-yellow-700'
                          : 'bg-violet-50 text-violet-600',
                      )}>
                        {f.kind === 'upload' ? <FileText className="h-4 w-4" /> :
                          isCloudLink ? <HardDrive className="h-4 w-4" /> :
                          <LinkIcon className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-800 truncate">{f.name}</p>
                        {f.kind === 'link' ? (
                          <p className="text-[11px] text-slate-500 mt-0.5 break-all font-mono">{f.url}</p>
                        ) : (
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
                          onClick={() => {
                            if (confirm(`Remove "${f.name}"?`)) remove.mutate(f.id);
                          }}
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
              })}
            </tbody>
          </table>
        </div>
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
