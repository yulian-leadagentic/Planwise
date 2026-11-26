/**
 * QA6 round 2 (26.11) · the Code cell of Templates › Services. A row with
 * no code (every project phase, some services) shows a muted "No code",
 * not a long dash.
 */
export function ServiceCodeCell({ code }: { code: string | null | undefined }) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value) return <span className="text-[11px] text-slate-400 dark:text-slate-500">No code</span>;
  return (
    <span className="rounded-[5px] bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 text-[11px] font-bold tracking-wide px-2 py-0.5">{value}</span>
  );
}
