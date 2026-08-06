import { MessagePanel } from '@/features/messaging/message-panel';

export function TaskDiscussionTab({ taskId }: { taskId: number }) {
  return <MessagePanel entityType="task" entityId={taskId} />;
}
