import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { notify } from '@/lib/notify';
import { inputClass, btnPrimary, btnSecondary, ZONE_TYPES, ZONE_DISPLAY } from './constants';

/**
 * Inline "New manual zone" form for the routed template EditorView
 * (QA3 Wave-2 Commit 5 · PR-032). Backend `POST /templates/:id/zones`
 * already accepts `zoneType`; the previous flows (ZoneTemplatePicker
 * for reference, no manual option) hardcoded `'zone'`, so template
 * authors had no way to tag a zone as Site / Building / Level etc.
 * without editing every row after the fact.
 *
 * Reuses the ZONE_TYPES catalog from `./constants` so the picker
 * options stay in sync with ZoneTypeBadge's display map.
 */
export function ManualZoneForm({
  templateId,
  parentId,
  onDone,
}: {
  templateId: number;
  /** null = root-level zone. */
  parentId: number | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [zoneType, setZoneType] = useState<string>('zone');

  const createZone = useMutation({
    mutationFn: (payload: Record<string, any>) =>
      client.post(`/templates/${templateId}/zones`, payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates', 'zone'] });
      notify.success('Zone added', { code: 'ZONE-CREATE-200' });
      onDone();
    },
    onError: (err: any) => notify.apiError(err, 'Failed to add zone'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createZone.mutate({
      name: name.trim(),
      zoneType,
      parentId: parentId ?? undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-brand-50/40 dark:bg-slate-800/40 px-3 py-2.5"
    >
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {parentId === null ? 'New root zone:' : 'New child zone:'}
      </span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Zone name *"
        className={`${inputClass} !w-40`}
        autoFocus
      />
      <select
        value={zoneType}
        onChange={(e) => setZoneType(e.target.value)}
        className={`${inputClass} !w-32`}
        aria-label="Zone type"
      >
        {ZONE_TYPES.map((zt) => (
          <option key={zt} value={zt}>
            {ZONE_DISPLAY[zt]?.label ?? zt}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={createZone.isPending || !name.trim()}
        className={btnPrimary}
      >
        {createZone.isPending ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={onDone} className={btnSecondary}>
        Cancel
      </button>
    </form>
  );
}
