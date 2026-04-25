import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, Reply, Pencil, Trash2, AtSign, ChevronDown, ChevronRight, CheckCircle, Sparkles, XCircle, Users, UserPlus, Search, Check } from 'lucide-react';
import { useMessages, useCreateMessage, useDeleteMessage } from '@/hooks/use-messages';
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

function MentionAutocomplete({ search, onSelect, onClose }: {
  search: string;
  onSelect: (user: any) => void;
  onClose: () => void;
}) {
  const { data: users = [] } = useQuery<any[]>({
    queryKey: ['users-active-mention', search],
    staleTime: 30 * 1000,
    queryFn: () =>
      client.get('/users?isActive=true').then((r) => {
        const d = r.data?.data ?? r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const filtered = useMemo(() => {
    if (!search) return users.slice(0, 8);
    const q = search.toLowerCase();
    return users.filter((u: any) => {
      const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.toLowerCase();
      return name.includes(q) || (u.email ?? '').toLowerCase().includes(q);
    }).slice(0, 8);
  }, [users, search]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (filtered.length === 0) return null;

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-slate-200 bg-white shadow-xl z-20">
      <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">
        Mention a team member
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {filtered.map((u: any) => (
          <button
            key={u.id}
            type="button"
            onClick={() => onSelect(u)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-blue-50 text-left"
          >
            <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
              {getInitials(u.firstName ?? '', u.lastName ?? '')}
            </span>
            <span className="truncate text-slate-700">{u.firstName} {u.lastName}</span>
          </button>
        ))}
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
  const [mentionedUsers, setMentionedUsers] = useState<{ id: number; name: string }[]>([]);
  const [showRecipientPicker, setShowRecipientPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createMessage = useCreateMessage();

  // For "Project Team" quick add — resolve when this composer is for a project,
  // OR when nested inside a task whose project we know via ancestry. We only
  // fetch when the picker is open to avoid extra requests.
  const projectIdForRecipients = entityType === 'project' ? entityId : null;

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

  const handleSubmit = () => {
    if (!content.trim()) return;
    createMessage.mutate(
      {
        entityType,
        entityId,
        parentId,
        content: content.trim(),
        mentionedUserIds: mentionedUsers.map((u) => u.id),
      },
      {
        onSuccess: () => {
          setContent('');
          setMentionedUsers([]);
          onSent?.();
        },
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      {mentionSearch !== null && (
        <MentionAutocomplete
          search={mentionSearch}
          onSelect={handleMentionSelect}
          onClose={() => setMentionSearch(null)}
        />
      )}

      {/* Recipient bar — always visible to make the audience explicit */}
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-500 mt-1.5 shrink-0">To:</span>
        <div className="flex-1 flex flex-wrap items-center gap-1.5">
          {mentionedUsers.length === 0 ? (
            <span className="text-[12px] text-slate-400 italic py-1">
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
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600"
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

      <div className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={parentId ? 'Write a reply...' : 'Write a message... use @ to inline-mention'}
          rows={1}
          className="flex-1 resize-none text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
          style={{ minHeight: '24px', maxHeight: '120px' }}
        />
        <button
          onClick={handleSubmit}
          disabled={!content.trim() || createMessage.isPending}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shrink-0"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
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
    <div ref={ref} className="absolute right-0 top-full mt-1 w-80 rounded-lg border border-slate-200 bg-white shadow-xl z-30">
      {/* Quick groups */}
      <div className="p-2 border-b border-slate-100">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-2 pt-1 pb-1.5">
          Quick add
        </p>
        {projectId && (
          <button
            type="button"
            onClick={handleAddProjectTeam}
            disabled={projectTeamUsers.length === 0}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-600">
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 text-left">
              <span className="block font-medium">Project Team</span>
              <span className="block text-[11px] text-slate-400">{projectTeamUsers.length} member{projectTeamUsers.length === 1 ? '' : 's'}</span>
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={handleAddAllUsers}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-blue-50"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-100 text-violet-600">
            <Users className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1 text-left">
            <span className="block font-medium">All Users</span>
            <span className="block text-[11px] text-slate-400">{allUsers.length} active user{allUsers.length === 1 ? '' : 's'}</span>
          </span>
        </button>
      </div>

      {/* Search + individuals */}
      <div className="p-2">
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            placeholder="Search by name or email..."
            className="w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-1 pt-0.5 pb-1">
          {search ? 'Results' : 'People'}
        </p>
        <div className="max-h-56 overflow-y-auto">
          {filteredUsers.length === 0 ? (
            <p className="px-2 py-3 text-center text-[12px] text-slate-400">No matches</p>
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
                    isSelected ? 'bg-slate-50 text-slate-400 cursor-default' : 'hover:bg-blue-50 text-slate-700',
                  )}
                >
                  <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 text-[9px] font-semibold flex items-center justify-center shrink-0">
                    {getInitials(u.firstName ?? '', u.lastName ?? '')}
                  </span>
                  <span className="flex-1 truncate">
                    {u.firstName} {u.lastName}
                    {u.email && <span className="block text-[10px] text-slate-400 truncate">{u.email}</span>}
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
  const deleteMessage = useDeleteMessage();
  const author = message.author;
  const isSystem = message.type === 'system';
  const replyCount = message._count?.replies ?? message.replies?.length ?? 0;

  if (isSystem) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-3 text-[12px] text-slate-400 italic">
        <div className="h-px flex-1 bg-slate-100" />
        <span>{message.content}</span>
        <div className="h-px flex-1 bg-slate-100" />
      </div>
    );
  }

  return (
    <div className={cn('py-2', depth > 0 && 'ml-8 border-l-2 border-slate-100 pl-3')}>
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
          {author ? getInitials(author.firstName, author.lastName) : '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-800">
              {author ? `${author.firstName} ${author.lastName}` : 'Unknown'}
            </span>
            <span className="text-[11px] text-slate-400">{formatRelative(message.createdAt)}</span>
            {message.isEdited && <span className="text-[10px] text-slate-400 italic">(edited)</span>}
            {message.source && message.source !== 'internal' && (
              <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700">
                {message.source}
              </span>
            )}
          </div>
          <p className="text-[13px] text-slate-700 mt-0.5 whitespace-pre-wrap break-words">{message.content}</p>

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

          {/* Actions */}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <button
              onClick={() => setShowReply(!showReply)}
              className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-blue-600"
            >
              <Reply className="h-3 w-3" />Reply
            </button>
            {replyCount > 0 && depth === 0 && (
              <button
                onClick={() => setShowReplies(!showReplies)}
                className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700"
              >
                {showReplies ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
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
  });

  const unresolveMutation = useMutation({
    mutationFn: () => client.post(`/messages/${messageId}/unresolve`).then((r) => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages', entityType, entityId] }),
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
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-green-600"
          title="Mark as resolved"
        >
          <CheckCircle className="h-3 w-3" /> Resolve
        </button>
      )}
      <button
        onClick={() => { if (!showSummary) fetchSummary(); setShowSummary(!showSummary); }}
        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-purple-600"
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
                  'bg-slate-100 text-slate-500',
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
        <h3 className="text-sm font-semibold text-slate-700">Discussion</h3>
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
        <div className="py-6 text-center text-sm text-slate-400">Loading messages...</div>
      ) : messages.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400">
          No messages yet. Start the discussion.
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
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
