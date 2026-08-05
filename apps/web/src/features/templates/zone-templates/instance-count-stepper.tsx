import { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Instance Count Stepper
// ---------------------------------------------------------------------------
// "× N" badge that lets the template author set how many times this zone
// should be instantiated when the template is applied to a project. Default
// (and minimum) is 1, max is intentionally generous (50) — bigger than that
// is almost certainly a mistake.

export function InstanceCountStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.max(1, Math.floor(value || 1))));
  // Escape must CANCEL, not commit. It sets draft back to `value` and closes,
  // but closing unmounts the input and fires onBlur -> commit(), which read the
  // still-stale draft (setState is async) and saved the typed value. This ref
  // lets commit() bail out on a cancel.
  const cancelledRef = useRef(false);

  // Re-sync draft when the saved value changes (e.g. another tab updated).
  useEffect(() => { setDraft(String(Math.max(1, Math.floor(value || 1)))); }, [value]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      setDraft(String(Math.max(1, Math.floor(value || 1))));
      return;
    }
    const n = Math.max(1, Math.min(50, Math.floor(Number(draft) || 1)));
    setEditing(false);
    if (n !== value) onChange(n);
    setDraft(String(n));
  };

  if (editing) {
    return (
      <input
        type="number"
        min={1}
        max={50}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { cancelledRef.current = true; setDraft(String(value)); setEditing(false); }
        }}
        autoFocus
        className="w-12 rounded border border-blue-400 px-1 py-0.5 text-xs text-center focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
    );
  }

  // Hide entirely when value is 1 — the default case shouldn't add visual noise.
  // Instead show a subtle "× 1" only on hover via a button-shaped target so the
  // author still has a way to *increase* it.
  if (value <= 1) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border border-dashed border-slate-300 dark:border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-400 dark:text-slate-500 hover:border-blue-400 hover:text-blue-600"
        title="Set instance count — when > 1, this zone is created N times when the template is applied"
      >
        × 1
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 hover:border-blue-500"
      title={`Will instantiate ${value} times when the template is applied to a project. Click to change.`}
    >
      × {value}
    </button>
  );
}
