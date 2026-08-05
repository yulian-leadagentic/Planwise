import { useState, useEffect, useRef } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { MessagePanel } from './message-panel';
import { cn } from '@/lib/utils';

interface DiscussionDrawerProps {
  open: boolean;
  onClose: () => void;
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
  title?: string;
}

export function DiscussionDrawer({ open, onClose, entityType, entityId, title }: DiscussionDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div ref={drawerRef}
        className="fixed inset-y-0 right-0 z-50 w-[480px] max-w-[90vw] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-700 px-5 py-4">
          <MessageSquare className="h-5 w-5 text-blue-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              {title || 'Discussion'}
            </h2>
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              {entityType === 'project' ? 'Project discussion' : entityType === 'task' ? 'Task discussion' : 'Zone discussion'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4"  aria-hidden="true" />
          </button>
        </div>

        {/* Message Panel */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <MessagePanel entityType={entityType} entityId={entityId} />
        </div>
      </div>
    </>
  );
}
