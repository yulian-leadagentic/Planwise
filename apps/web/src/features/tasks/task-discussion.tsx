import { useState } from 'react';
import { Send, Reply, Trash2 } from 'lucide-react';
import { UserAvatar } from '@/components/shared/user-avatar';
import { useTaskComments, useCreateComment, useDeleteComment } from '@/hooks/use-tasks';
import { useAuthStore } from '@/stores/auth.store';
import { formatRelative } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import type { TaskComment } from '@/types';

interface TaskDiscussionProps {
  taskId: number;
}

export function TaskDiscussion({ taskId }: TaskDiscussionProps) {
  const { data: comments } = useTaskComments(taskId);
  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();
  const user = useAuthStore((s) => s.user);
  const [content, setContent] = useState('');
  const [replyTo, setReplyTo] = useState<number | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    createComment.mutate(
      {
        taskId,
        content: content.trim(),
        parentId: replyTo,
      },
      {
        onSuccess: () => {
          setContent('');
          setReplyTo(null);
        },
      },
    );
  };

  const topLevelComments = (comments ?? []).filter((c) => !c.parentId);

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="mb-4 font-medium">Discussion</h3>

      {/* Comment list */}
      <div className="space-y-4">
        {topLevelComments.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No comments yet. Start the discussion!
          </p>
        ) : (
          topLevelComments.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              taskId={taskId}
              currentUserId={user?.id}
              onReply={(id) => setReplyTo(id)}
              onDelete={(commentId) => deleteComment.mutate({ taskId, commentId })}
            />
          ))
        )}
      </div>

      {/* Reply indicator */}
      {replyTo && (
        <div className="mt-4 flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm text-muted-foreground">
          <Reply className="h-4 w-4" />
          <span>Replying to comment</span>
          <button
            onClick={() => setReplyTo(null)}
            className="ml-auto text-xs hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {/* New comment form */}
      <form onSubmit={handleSubmit} className="mt-4 flex items-start gap-3">
        {user && (
          <UserAvatar
            firstName={user.firstName}
            lastName={user.lastName}
            avatarUrl={user.avatarUrl}
            size="sm"
          />
        )}
        <div className="flex-1">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write a comment..."
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={!content.trim() || createComment.isPending}
              className="flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              Comment
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

interface CommentThreadProps {
  comment: TaskComment;
  taskId: number;
  currentUserId?: number;
  onReply: (commentId: number) => void;
  onDelete: (commentId: number) => void;
  depth?: number;
}

function CommentThread({
  comment,
  taskId,
  currentUserId,
  onReply,
  onDelete,
  depth = 0,
}: CommentThreadProps) {
  const isOwn = comment.userId === currentUserId;

  return (
    <div className={cn(depth > 0 && 'ml-8 border-l-2 border-border pl-4')}>
      <div className="group flex items-start gap-3">
        <UserAvatar
          firstName={comment.user?.firstName ?? ''}
          lastName={comment.user?.lastName ?? ''}
          avatarUrl={comment.user?.avatarUrl}
          size="sm"
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {comment.user?.firstName} {comment.user?.lastName}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatRelative(comment.createdAt)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
            {comment.content}
          </p>
          <div className="mt-1 flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => onReply(comment.id)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Reply
            </button>
            {isOwn && (
              <button
                onClick={() => onDelete(comment.id)}
                className="text-xs text-red-500 hover:text-red-600"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="mt-3 space-y-3">
          {comment.replies.map((reply) => (
            <CommentThread
              key={reply.id}
              comment={reply}
              taskId={taskId}
              currentUserId={currentUserId}
              onReply={onReply}
              onDelete={onDelete}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
