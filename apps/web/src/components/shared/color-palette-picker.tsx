import { useState, useRef, useEffect } from 'react';
import { Check, ChevronDown, Pipette } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Curated palette for type / category badges. The set is hand-picked to
 * (a) cover the visual spectrum without near-duplicates, (b) be legible
 * as both a fill (label background) and as a border / icon colour, and
 * (c) work in both light and dark UI surroundings.
 */
const PALETTE: { name: string; value: string }[] = [
  { name: 'Slate',   value: '#64748B' },
  { name: 'Gray',    value: '#6B7280' },
  { name: 'Red',     value: '#EF4444' },
  { name: 'Orange',  value: '#F97316' },
  { name: 'Amber',   value: '#F59E0B' },
  { name: 'Yellow',  value: '#EAB308' },
  { name: 'Lime',    value: '#84CC16' },
  { name: 'Green',   value: '#22C55E' },
  { name: 'Emerald', value: '#10B981' },
  { name: 'Teal',    value: '#14B8A6' },
  { name: 'Cyan',    value: '#06B6D4' },
  { name: 'Sky',     value: '#0EA5E9' },
  { name: 'Blue',    value: '#3B82F6' },
  { name: 'Indigo',  value: '#6366F1' },
  { name: 'Violet',  value: '#8B5CF6' },
  { name: 'Purple',  value: '#A855F7' },
  { name: 'Fuchsia', value: '#D946EF' },
  { name: 'Pink',    value: '#EC4899' },
  { name: 'Rose',    value: '#F43F5E' },
  { name: 'Brown',   value: '#92400E' },
];

interface Props {
  value: string;
  onChange: (color: string) => void;
  className?: string;
  /** Allow typing a custom hex outside the curated palette. Default true. */
  allowCustom?: boolean;
}

export function ColorPalettePicker({ value, onChange, className, allowCustom = true }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(value);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCustom(value), [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const safeHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;

  return (
    <div className={cn('relative inline-block', className)} ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label="Choose colour"
      >
        <span
          className="h-5 w-5 rounded border border-slate-300 shrink-0"
          style={{ backgroundColor: value }}
        />
        <span className="font-mono text-xs text-slate-600">{value}</span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-[260px] rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Palette</p>
          <div className="grid grid-cols-5 gap-2">
            {PALETTE.map((c) => {
              const selected = c.value.toLowerCase() === value.toLowerCase();
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => { onChange(c.value); setOpen(false); }}
                  title={`${c.name} (${c.value})`}
                  className={cn(
                    'h-8 w-8 rounded-md border-2 transition-transform hover:scale-110 flex items-center justify-center',
                    selected ? 'border-slate-900 ring-2 ring-blue-300' : 'border-white shadow',
                  )}
                  style={{ backgroundColor: c.value }}
                >
                  {selected && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
                </button>
              );
            })}
          </div>

          {allowCustom && (
            <>
              <div className="mt-3 mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <Pipette className="h-3 w-3" />
                Custom hex
              </div>
              <div className="flex items-center gap-1.5">
                {/* native colour picker for users who really want a custom value */}
                <input
                  type="color"
                  value={safeHex(custom) ?? '#000000'}
                  onChange={(e) => { setCustom(e.target.value); onChange(e.target.value); }}
                  className="h-8 w-10 rounded border border-input cursor-pointer p-0"
                />
                <input
                  type="text"
                  value={custom}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustom(v);
                    if (safeHex(v)) onChange(v);
                  }}
                  placeholder="#3B82F6"
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
