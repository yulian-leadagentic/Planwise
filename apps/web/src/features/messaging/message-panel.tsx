import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, Reply, Pencil, Trash2, AtSign, ChevronDown, ChevronRight, CheckCircle, Sparkles, XCircle, Users, UserPlus, Search, Check, Paperclip, FileText, X } from 'lucide-react';
import { notify } from '@/lib/notify';
import { useMessages, useCreateMessage, useDeleteMessage, useUpdateMessage } from '@/hooks/use-messages';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/date-utils';
import client from '@/api/client';

interface MessagePanelProps {
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
}

function getInitials(firstName: string, lastName: string) {
  return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
}

// ─── Mention Autocomplete ────────────────────────────────────────────────────
//
// Controlled renderer. The composer owns the filtered users list AND the
// active highlight index so the popup and the textarea share keyboard
// state — the composer's onKeyDown intercepts ↑/↓/Enter/Tab/Escape
// while the popup is open and reflects the current highlight back here.

function MentionAutocomplete({ users, activeIndex, onHoverIndex, onSelect, onClose }: {
  users: any[];
  activeIndex: number;
  onHoverIndex: (i: number) => void;
  onSelect: (user: any) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (users.length === 0) return null;

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl z-20"
    >
      <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800">
        Mention a team member
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {users.map((u: any, i: number) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={isActive}
              // onMouseDown (not onClick) so the pick fires BEFORE the
              // textarea's blur — otherwise the popup closes on the blur
              // without ever inserting the name.
              onMouseDown={(e) => { e.preventDefault(); onSelect(u); }}
              onMouseEnter={() => onHoverIndex(i)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
                isActive
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-700 dark:text-slate-200',
              )}
            >
              <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                {getInitials(u.firstName ?? '', u.lastName ?? '')}
              </span>
              <span className="truncate">{u.firstName} {u.lastName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Message Composer ────────────────────────────────────────────────────────

function MessageComposer({ entityType, entityId, parentId, onSent }: {
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
  parentId?: number;
  onSent?: () => void;
}) {
  const [content, setContent] = useState('');
  const [mentionSearch, setMentionSearch] = useState<string | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionedUsers, setMentionedUsers] = useState<{ id: number; name: string }[]>([]);
  const [showRecipientPicker, setShowRecipientPicker] = useState(false);
  // Attachments — files chosen via the paperclip icon. Upload happens on
  // submit (one round-trip per file via /files/upload), then their
  // descriptors are sent alongside the message create payload. Stored
  // in Message.metadata.attachments on the server so existing readers
  // keep working.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createMessage = useCreateMessage();

  // For "Project Team" quick add — resolve when this composer is for a project,
  // OR when nested inside a task whose project we know via ancestry. We only
  // fetch when the picker is open to avoid extra requests.
  const projectIdForRecipients = entityType === 'project' ? entityId : null;

  // Mention users — lifted out of MentionAutocomplete so the composer's
  // onKeyDown can read the current filtered list to select by index
  // (Arrow keys + Enter/Tab), and so a single cached fetch backs the
  // popup across search-term changes (previously the queryKey included
  // the search term, wasting the cache).
  const { data: mentionUsers = [] } = useQuery<any[]>({
    queryKey: ['users-active-mention'],
    staleTime: 30 * 1000,
    enabled: mentionSearch !== null,
    queryFn: () =>
      client.get('/users?isActive=true&perPage=1000').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const filteredMentions = useMemo(() => {
    if (mentionSearch === null) return [] as any[];
    if (!mentionSearch) return mentionUsers.slice(0, 8);
    const q = mentionSearch.toLowerCase();
    return mentionUsers
      .filter((u: any) => {
        const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
        return name.includes(q) || (u.email ?? '').toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [mentionUsers, mentionSearch]);

  // Whether the mention popup is currently "capturing" keystrokes.
  // We're in mention MODE any time mentionSearch !== null (the user is
  // mid-@type) — even when zero users match, send stays suppressed so
  // an accidental Enter can't fire the message. Escape / typing past
  // the token / picking a match all exit the mode.
  const mentionOpen = mentionSearch !== null;

  // Reset the highlighted row when the filter set changes so the arrow
  // keys don't try to select an out-of-range index.
  useEffect(() => {
    setMentionActiveIndex(0);
  }, [mentionSearch, filteredMentions.length]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);

    // Detect @mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setMentionSearch(atMatch[1]);
    } else {
      setMentionSearch(null);
    }
  };

  const handleMentionSelect = (user: any) => {
    const name = `${user.firstName} ${user.lastName}`;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = content.substring(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    const before = content.substring(0, atIndex);
    const after = content.substring(cursorPos);
    const newContent = `${before}@${name} ${after}`;
    setContent(newContent);
    setMentionSearch(null);
    setMentionedUsers((prev) => {
      if (prev.some((u) => u.id === user.id)) return prev;
      return [...prev, { id: user.id, name }];
    });
    textarea.focus();
  };

  const handleSubmit = async () => {
    if (!content.trim() && pendingFiles.length === 0) return;
    const attachments: Array<{ fileName: string; fileUrl: string; fileSize?: number; mimeType?: string }> = [];
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        for (const f of pendingFiles) {
          const fd = new FormData();
          fd.append('file', f);
          fd.append('folder', 'attachments');
          const res = await client.post('/files/upload', fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
          const data = res.data?.data ?? res.data;
          attachments.push({
            fileName: f.name,
            fileUrl: data.url,
            fileSize: f.size,
            mimeType: f.type || undefined,
          });
        }
      } catch (err: any) {
        notify.apiError(err, 'Failed to upload attachment');
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    createMessage.mutate(
      {
        entityType,
        entityId,
        parentId,
        content: content.trim() || '(attachment)',
        mentionedUserIds: mentionedUsers.map((u) => u.id),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      {
        onSuccess: () => {
          setContent('');
          setMentionedUsers([]);
          setPendingFiles([]);
          onSent?.();
        },
      },
    );
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setPendingFiles((prev) => [...prev, ...Array.from(files)]);
    }
    if (e.target.value) e.target.value = '';
  };

  const removePendingFile = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Mention mode captures navigation keys and, critically, SUPPRESSES
    // the plain-Enter → send path. Otherwise typing "@amit<Enter>" sent
    // the message instead of picking Amit.
    if (mentionOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionSearch(null);
        return;
      }
      if (filteredMentions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionActiveIndex((i) => (i + 1) % filteredMentions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionActiveIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          handleMentionSelect(filteredMentions[mentionActiveIndex]);
          return;
        }
      }
      // Zero matches — still swallow plain Enter so an accidental send
      // can't slip through while the user is mid-@ typing.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        return;
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const addRecipients = (newUsers: { id: number; name: string }[]) => {
    setMentionedUsers((prev) => {
      const seen = new Set(prev.map((u) => u.id));
      const merged = [...prev];
      for (const u of newUsers) if (!seen.has(u.id)) merged.push(u);
      return merged;
    });
  };

  const removeRecipient = (userId: number) => {
    setMentionedUsers((prev) => prev.filter((u) => u.id !== userId));
  };

  return (
    <div className="relative">
      {mentionOpen && (
        <MentionAutocomplete
          users={filteredMentions}
          activeIndex={mentionActiveIndex}
          onHoverIndex={setMentionActiveIndex}
          onSelect={handleMentionSelect}
          onClose={() => setMentionSearch(null)}
        />
      )}

      {/* Recipient bar — always visible to make the audience explicit */}
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-1.5 shrink-0">To:</span>
        <div className="flex-1 flex flex-wrap items-center gap-1.5">
          {mentionedUsers.length === 0 ? (
            <span className="text-[12px] text-slate-400 dark:text-slate-500 italic py-1">
              Visible in this {entityType} discussion. Add recipients to notify specific people.
            </span>
          ) : (
            mentionedUsers.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                {u.name}
                <button onClick={() => removeRecipient(u.id)} className="ml-0.5 hover:text-red-600 leading-none" aria-label={`Remove ${u.name}`}>×</button>
              </span>
            ))
          )}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setShowRecipientPicker(!showRecipientPicker)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600"
          >
            <UserPlus className="h-3 w-3" />
            Add recipients
          </button>
          {showRecipientPicker && (
            <RecipientPicker
              projectId={projectIdForRecipients}
              alreadySelected={mentionedUsers}
              onAdd={addRecipients}
              onClose={() => setShowRecipientPicker(false)}
            />
          )}
        </div>
      </div>

      {/* Pending attachment chips — render above the textarea so they're
          visible while the user is typing. Click ✕ to drop one before
          send. Files upload only on submit, not when picked. */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50/40 px-2 py-1.5">
          {pendingFiles.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] text-slate-700 dark:text-slate-200"
              title={`${f.name} (${(f.size / 1024).toFixed(0)} KB)`}
            >
              <FileText className="h-3 w-3 text-blue-500" />
              <span className="truncate max-w-[160px]">{f.name}</span>
              <button
                type="button"
                onClick={() => removePendingFile(i)}
                className="ml-0.5 text-slate-400 dark:text-slate-500 hover:text-red-500"
                aria-label={`Remove ${f.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFilePick}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || createMessage.isPending}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-100 disabled:opacity-50 shrink-0"
          title="Attach files"
          aria-label="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={parentId ? 'Write a reply...' : 'Write a message... use @ to inline-mention'}
          rows={1}
          className="flex-1 resize-none text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
          style={{ minHeight: '24px', maxHeight: '120px' }}
        />
        <button
          onClick={handleSubmit}
          disabled={(!content.trim() && pendingFiles.length === 0) || createMessage.isPending || uploading}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shrink-0"
          title={uploading ? 'Uploading...' : 'Send'}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Renders the attachment chips below a message bubble. Read from the
 * message.metadata.attachments JSON array. Each chip links to the file
 * URL — task attachments live under /uploads/* which the backend serves
 * with cookie auth, so a plain <a> works.
 */
export function MessageAttachments({ metadata }: { metadata: any }) {
  const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {attachments.map((a: any, i: number) => (
        <a
          key={`${a.fileUrl}-${i}`}
          href={a.fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-2 py-0.5 text-[11px] text-slate-700 dark:text-slate-200 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
          title={a.fileName}
        >
          <FileText className="h-3 w-3 text-blue-500" />
          <span className="truncate max-w-[200px]">{a.fileName}</span>
          {a.fileSize ? (
            <span className="text-slate-400 dark:text-slate-500 ml-0.5">
              {a.fileSize < 1024
                ? `${a.fileSize}B`
                : a.fileSize < 1024 * 1024
                  ? `${(a.fileSize / 1024).toFixed(0)}KB`
                  : `${(a.fileSize / 1024 / 1024).toFixed(1)}MB`}
            </span>
          ) : null}
        </a>
      ))}
    </div>
  );
}

// ─── Recipient Picker ─────────────────────────────────────────────────────────

function RecipientPicker({
  projectId,
  alreadySelected,
  onAdd,
  onClose,
}: {
  projectId: number | null;
  alreadySelected: { id: number; name: string }[];
  onAdd: (users: { id: number; name: string }[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  const { data: allUsers = [] } = useQuery<any[]>({
    queryKey: ['users-active-for-recipients'],
    staleTime: 30 * 1000,
    queryFn: () => client.get('/users?isActive=true&perPage=200').then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const { data: members = [] } = useQuery<any[]>({
    queryKey: ['project-members', projectId],
    enabled: !!projectId,
    staleTime: 60 * 1000,
    queryFn: () => client.get(`/projects/${projectId}/members`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : [];
    }),
  });

  const projectTeamUsers = useMemo(() => {
    return members
      .map((m: any) => m.user)
      .filter((u: any) => u && u.id);
  }, [members]);

  const selectedIds = useMemo(() => new Set(alreadySelected.map((u) => u.id)), [alreadySelected]);

  const filteredUsers = useMemo(() => {
    if (!search) return allUsers;
    const q = search.toLowerCase();
    return allUsers.filter((u: any) => {
      const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return name.includes(q) || (u.email ?? '').toLowerCase().includes(q);
    });
  }, [allUsers, search]);

  const toUserChip = (u: any) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` });

  const handleAddAllUsers = () => {
    onAdd(allUsers.map(toUserChip));
    onClose();
  };

  const handleAddProjectTeam = () => {
    onAdd(projectTeamUsers.map(toUserChip));
    onClose();
  };

  const handleToggleUser = (u: any) => {
    if (selectedIds.has(u.id)) return;
    onAdd([toUserChip(u)]);
  };

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-80 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl z-30">
      {/* Quick groups */}
      <div className="p-2 border-b border-slate-100 dark:border-slate-800">
        <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-2 pt-1 pb-1.5">
          Quick add
        </p>
        {projectId && (
          <button
            type="button"
            onClick={handleAddProjectTeam}
            disabled={projectTeamUsers.length === 0}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-600">
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 text-left">
              <span className="block font-medium">Project Team</span>
              <span className="block text-[11px] text-slate-400 dark:text-slate-500">{projectTeamUsers.length} member{projectTeamUsers.length === 1 ? '' : 's'}</span>
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={handleAddAllUsers}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200 hover:bg-blue-50"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-600">
            <Users className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1 text-left">
            <span className="block font-medium">All Users</span>
            <span className="block text-[11px] text-slate-400 dark:text-slate-500">{allUsers.length} active user{allUsers.length === 1 ? '' : 's'}</span>
          </span>
        </button>
      </div>

      {/* Search + individuals */}
      <div className="p-2">
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            placeholder="Search by name or email..."
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-7 pr-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-1 pt-0.5 pb-1">
          {search ? 'Results' : 'People'}
        </p>
        <div className="max-h-56 overflow-y-auto">
          {filteredUsers.length === 0 ? (
            <p className="px-2 py-3 text-center text-[12px] text-slate-400 dark:text-slate-500">No matches</p>
          ) : (
            filteredUsers.map((u: any) => {
              const isSelected = selectedIds.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => handleToggleUser(u)}
                  disabled={isSelected}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left transition-colors',
                    isSelected ? 'bg-slate-50 dark:bg-slate-800/50 text-slate-400 dark:text-slate-500 cursor-default' : 'hover:bg-blue-50 text-slate-700 dark:text-slate-200',
                  )}
                >
                  <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                    {getInitials(u.firstName ?? '', u.lastName ?? '')}
                  </span>
                  <span className="flex-1 truncate">
                    {u.firstName} {u.lastName}
                    {u.email && <span className="block text-[10px] text-slate-400 dark:text-slate-500 truncate">{u.email}</span>}
                  </span>
                  {isSelected && <Check className="h-3.5 w-3.5 text-blue-600 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Message Item ────────────────────────────────────────────────────────────

function MessageItem({ message, entityType, entityId, depth = 0 }: {
  message: any;
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
  depth?: number;
}) {
  const [showReply, setShowReply] = useState(false);
  const [showReplies, setShowReplies] = useState(depth === 0);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState<string>(message.content ?? '');
  const deleteMessage = useDeleteMessage();
  const updateMessage = useUpdateMessage();
  const confirm = useConfirm();
  // Author-vs-viewer check. Own messages surface Edit/Delete affordances;
  // everyone else's are read-only. Falls back to false when the auth
  // store hasn't loaded a user yet, so the affordances only appear once
  // we can confirm identity.
  const currentUserId = useAuthStore((s) => s.user?.id);
  const author = message.author;
  const isOwn = !!currentUserId && author?.id === currentUserId;
  const isSystem = message.type === 'system';
  const replyCount = message._count?.replies ?? message.replies?.length ?? 0;

  const handleSaveEdit = () => {
    const next = editContent.trim();
    // Empty edit → treat as no-op (delete flow is explicit via trash icon).
    if (!next || next === (message.content ?? '')) {
      setEditing(false);
      return;
    }
    updateMessage.mutate(
      { id: message.id, content: next },
      { onSuccess: () => setEditing(false) },
    );
  };

  const handleDelete = async () => {
    if (await confirm('Delete this message? This cannot be undone.')) {
      deleteMessage.mutate(message.id);
    }
  };

  if (isSystem) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-3 text-[12px] text-slate-400 dark:text-slate-500 italic">
        <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
        <span>{message.content}</span>
        <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
      </div>
    );
  }

  return (
    <div className={cn('py-2', depth > 0 && 'ml-8 border-l-2 border-slate-100 dark:border-slate-800 pl-3')}>
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
          {author ? getInitials(author.firstName, author.lastName) : '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
              {author ? `${author.firstName} ${author.lastName}` : 'Unknown'}
            </span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">{formatRelative(message.createdAt)}</span>
            {message.isEdited && <span className="text-[10px] text-slate-400 dark:text-slate-500 italic">(edited)</span>}
            {message.source && message.source !== 'internal' && (
              <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700">
                {message.source}
              </span>
            )}
          </div>
          {editing ? (
            <div className="mt-1 space-y-1.5">
              <textarea
                autoFocus
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter → save. Escape → cancel. Plain Enter
                  // inserts a newline (multi-line messages are a thing).
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSaveEdit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditing(false);
                    setEditContent(message.content ?? '');
                  }
                }}
                rows={Math.max(2, Math.min(6, (editContent.match(/\n/g)?.length ?? 0) + 1))}
                className="w-full rounded-md border border-blue-300 dark:border-blue-500 bg-white dark:bg-slate-900 px-2 py-1.5 text-[13px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none resize-y"
                aria-label="Edit message"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={updateMessage.isPending || !editContent.trim()}
                  className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {updateMessage.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setEditContent(message.content ?? ''); }}
                  disabled={updateMessage.isPending}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-1">
                  Cmd/Ctrl+Enter to save · Esc to cancel
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-slate-700 dark:text-slate-200 mt-0.5 whitespace-pre-wrap break-words">{message.content}</p>
          )}

          {/* Attachment chips — files attached when the user sent the
              message. metadata.attachments is an array of {fileName,
              fileUrl, fileSize, mimeType}; empty / missing renders nothing. */}
          <MessageAttachments metadata={message.metadata} />

          {/* Mentions */}
          {message.mentions?.length > 0 && (
            <div className="flex gap-1 mt-1">
              {message.mentions.map((m: any) => (
                <span key={m.id} className="inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                  @{m.user?.firstName} {m.user?.lastName}
                </span>
              ))}
            </div>
          )}

          {/* Actions — Edit/Delete only rendered for the author of the
              message so viewers never see affordances they can't use
              (server also rejects, but hiding is the friendlier UX). */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <button
              onClick={() => setShowReply(!showReply)}
              className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 hover:text-blue-600"
            >
              <Reply className="h-3 w-3" aria-hidden="true" />Reply
            </button>
            {isOwn && !editing && (
              <>
                <button
                  onClick={() => { setEditContent(message.content ?? ''); setEditing(true); }}
                  className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 hover:text-blue-600"
                  aria-label="Edit your message"
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />Edit
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleteMessage.isPending}
                  className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 hover:text-red-600 disabled:opacity-50"
                  aria-label="Delete your message"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />Delete
                </button>
              </>
            )}
            {replyCount > 0 && depth === 0 && (
              <button
                onClick={() => setShowReplies(!showReplies)}
                className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700"
              >
                {showReplies ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
            {depth === 0 && (
              <ThreadActions messageId={message.id} entityType={entityType} entityId={entityId} isResolved={!!(message.metadata as any)?.resolved} />
            )}
          </div>
        </div>
      </div>

      {/* Reply composer */}
      {showReply && (
        <div className="mt-2 ml-10">
          <MessageComposer
            entityType={entityType}
            entityId={entityId}
            parentId={message.id}
            onSent={() => setShowReply(false)}
          />
        </div>
      )}

      {/* Thread replies */}
      {showReplies && message.replies?.length > 0 && (
        <div className="mt-1">
          {message.replies.map((reply: any) => (
            <MessageItem
              key={reply.id}
              message={reply}
              entityType={entityType}
              entityId={entityId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Thread Actions (resolve, summarize) ─────────────────────────────────────

function ThreadActions({ messageId, entityType, entityId, isResolved }: {
  messageId: number; entityType: string; entityId: number; isResolved: boolean;
}) {
  const [showSummary, setShowSummary] = useState(false);
  const queryClient = useQueryClient();

  const resolveMutation = useMutation({
    mutationFn: () => client.post(`/messages/${messageId}/resolve`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', entityType, entityId] }),
    onError: (err: any) => notify.apiError(err, 'Failed to resolve thread'),
  });

  const unresolveMutation = useMutation({
    mutationFn: () => client.post(`/messages/${messageId}/unresolve`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', entityType, entityId] }),
    onError: (err: any) => notify.apiError(err, 'Failed to unresolve thread'),
  });

  const { data: summary, isLoading: summarizing, refetch: fetchSummary } = useQuery({
    queryKey: ['messages', 'summary', messageId],
    queryFn: () => client.get(`/messages/${messageId}/summarize`).then((r) => r.data?.data ?? r.data),
    enabled: false,
  });

  return (
    <>
      {isResolved ? (
        <button
          onClick={() => unresolveMutation.mutate()}
          className="flex items-center gap-1 text-[11px] text-green-600 hover:text-amber-600"
          title="Mark as unresolved"
        >
          <CheckCircle className="h-3 w-3" /> Resolved
        </button>
      ) : (
        <button
          onClick={() => resolveMutation.mutate()}
          className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 hover:text-green-600"
          title="Mark as resolved"
        >
          <CheckCircle className="h-3 w-3" /> Resolve
        </button>
      )}
      <button
        onClick={() => { if (!showSummary) fetchSummary(); setShowSummary(!showSummary); }}
        className="flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500 hover:text-purple-600"
        title="AI Summary"
      >
        <Sparkles className="h-3 w-3" /> Summary
      </button>

      {showSummary && (
        <div className="w-full mt-2 rounded-lg border border-purple-200 bg-purple-50/50 p-3 text-[12px]">
          {summarizing ? (
            <p className="text-purple-500 animate-pulse">Analyzing thread...</p>
          ) : summary ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-purple-500" />
                <span className="font-semibold text-purple-800">Thread Summary</span>
                {(summary as any).isUrgent && (
                  <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-600">URGENT</span>
                )}
                <span className={cn(
                  'rounded-full px-1.5 py-0.5 text-[9px] font-bold',
                  (summary as any).sentiment === 'positive' ? 'bg-green-100 text-green-600' :
                  (summary as any).sentiment === 'negative' ? 'bg-red-100 text-red-600' :
                  'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
                )}>
                  {(summary as any).sentiment}
                </span>
              </div>
              <p className="text-purple-700">{(summary as any).summary}</p>
              <div className="flex items-center gap-3 text-[10px] text-purple-500">
                <span>{(summary as any).messageCount} messages</span>
                <span>{(summary as any).participantCount} participants</span>
                {(summary as any).topKeywords?.length > 0 && (
                  <span>Keywords: {(summary as any).topKeywords.join(', ')}</span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-purple-400">No data available</p>
          )}
        </div>
      )}
    </>
  );
}

// ─── Message Panel (main component) ─────────────────────────────────────────

export function MessagePanel({ entityType, entityId }: MessagePanelProps) {
  const { data, isLoading } = useMessages(entityType, entityId);
  const messages = (data as any)?.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-blue-600" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Discussion</h3>
        {messages.length > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
            {messages.length}
          </span>
        )}
      </div>

      {/* Composer at top */}
      <MessageComposer entityType={entityType} entityId={entityId} />

      {/* Messages */}
      {isLoading ? (
        <div className="py-6 text-center text-sm text-slate-400 dark:text-slate-500">Loading messages...</div>
      ) : messages.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400 dark:text-slate-500">
          No messages yet. Start the discussion.
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {messages.map((msg: any) => (
            <MessageItem
              key={msg.id}
              message={msg}
              entityType={entityType}
              entityId={entityId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
