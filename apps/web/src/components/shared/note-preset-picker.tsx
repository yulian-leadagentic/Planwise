import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareText, ChevronDown } from 'lucide-react';
import client from '@/api/client';
import { cn } from '@/lib/utils';

/**
 * Preset-phrase picker for time-log notes (Tier C #9b, 2026-06-30).
 *
 * Admins curate a pool of short description snippets on the admin
 * page; the picker fetches the active list and shows them as a
 * one-click popover next to the note textarea. Users can pile up
 * multiple phrases into a single note — clicking a phrase appends
 * it to whatever's already typed.
 *
 * Rendered ABOVE the textarea so it never obscures typing. Hidden
 * automatically when the admin pool is empty, so screens without
 * curated phrases stay uncluttered.
 */
export function NotePresetPicker({ onPick }: { onPick: (phrase: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const { data: phrases = [] } = useQuery<{ id: number; text: string }[]>({
    queryKey: ['admin', 'time-note-phrases', 'active'],
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      client.get('/admin/config/time-note-phrases/active').then((r) => {
        const d = r.data?.data ?? r.data ?? [];
        return Array.isArray(d) ? d : [];
      }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (phrases.length === 0) return null;

  return (
    <div ref={ref} className="relative mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-600 hover:text-blue-700 hover:underline"
      >
        <MessageSquareText className="h-3 w-3" />
        Insert preset phrase
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[320px] max-w-[92vw] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 bg-white p-1.5 max-h-64 overflow-y-auto">
          {phrases.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onPick(p.text);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 rounded-lg text-[12px] text-slate-700 hover:bg-slate-50"
            >
              {p.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
