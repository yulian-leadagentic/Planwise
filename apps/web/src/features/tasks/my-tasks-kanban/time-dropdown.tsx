import { TIME_SLOTS } from './constants';

export function TimeDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-[12px] focus:border-blue-400 focus:outline-none bg-white dark:bg-slate-900"
    >
      {/* Allow whatever the current value is, even if off-grid (e.g.
          legacy 09:07). Keeps the rendered <option> identifiable. */}
      {!TIME_SLOTS.includes(value) && value && <option value={value}>{value}</option>}
      {TIME_SLOTS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}
