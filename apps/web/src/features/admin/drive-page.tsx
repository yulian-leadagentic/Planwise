/**
 * Admin -> Google Drive integration page.
 *
 * Mirrors the shape of sso-page.tsx: card layout, write-only key input
 * with a "Replace key" toggle, keyHint from the ciphertext, test-
 * connection button, and a permissions gate that supports both
 * `can('org', 'read'|'write')` AND the roleId=1 admin bypass (the SSO
 * page missed this initially and had to be hotfixed).
 *
 * Read-only note explains the permission model: access to files is
 * controlled by Google (Shared Drive membership), NOT by Planwise.
 * Planwise never sets or modifies Drive permissions.
 *
 * The service-account JSON key is a TEXTAREA (multi-line) since a
 * typical SA JSON is ~2 KB. Everything else is a single-line input.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Loader2, Info, XCircle, CheckCircle2, HardDrive } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import client from '@/api/client';

// ─── Types (mirror the API response shape) ─────────────────────────

interface DriveConfigView {
  enabled: boolean;
  sharedDriveId: string;
  rootFolderId: string | null;
  hasKey: boolean;
  keyHint: string | null;
  keyVersion: number;
  updatedAt: string | null;
}

// Design-system tokens reused from the SSO page — keep the two admin
// integration pages visually identical so users learn the pattern once.
const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none';

const monoInputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none';

const textareaClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none resize-y min-h-[140px]';

const btnPrimary =
  'bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5';

const btnSecondary =
  'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5';

const card =
  'bg-white dark:bg-slate-900 rounded-[14px] border border-slate-200 dark:border-slate-700';

// ─── Page shell ───────────────────────────────────────────────────

export function DrivePage() {
  const { can, isAdmin } = usePermissions();
  // isAdmin OR-clause is REQUIRED — see hooks/use-permissions.ts.
  // Without it, a role=admin user without an explicit `org` row gets
  // locked out (same bug that hit SSO P1 on release).
  const canRead = isAdmin || can('org', 'read');
  const canWrite = isAdmin || can('org', 'write');

  const { data: config, isLoading } = useQuery<DriveConfigView>({
    queryKey: ['admin', 'drive'],
    enabled: canRead,
    staleTime: 60_000,
    queryFn: () => client.get('/admin/drive').then((r) => r.data.data ?? r.data),
  });

  if (!canRead) {
    return (
      <div className={cn(card, 'p-8 text-center')}>
        <ShieldCheck className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
        <h3 className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          You don't have permission to view Google Drive settings
        </h3>
        <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">
          Ask an administrator to grant you the "org" module read permission.
        </p>
      </div>
    );
  }

  // Placeholder default so the card can render before the query
  // resolves. Same trick as sso-page.tsx.
  const cfg: DriveConfigView = config ?? {
    enabled: false,
    sharedDriveId: '',
    rootFolderId: null,
    hasKey: false,
    keyHint: null,
    keyVersion: 0,
    updatedAt: null,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Google Drive"
        description="Store project folders and attach Drive files without leaving Planwise."
      />

      {isLoading ? (
        <div className={cn(card, 'h-64 animate-pulse')} />
      ) : (
        <div className="space-y-4">
          <DriveCard config={cfg} canWrite={canWrite} isExisting={cfg.hasKey} />
        </div>
      )}
    </div>
  );
}

// ─── Drive card ───────────────────────────────────────────────────

interface CardProps {
  config: DriveConfigView;
  canWrite: boolean;
  /** True when a SA key is already stored — controls whether the
   *  "Replace key" affordance is offered instead of the raw input. */
  isExisting: boolean;
}

function DriveCard({ config, canWrite, isExisting }: CardProps) {
  const queryClient = useQueryClient();
  const [sharedDriveId, setSharedDriveId] = useState(config.sharedDriveId ?? '');
  const [rootFolderId, setRootFolderId] = useState(config.rootFolderId ?? '');
  const [enabled, setEnabled] = useState<boolean>(config.enabled);
  // Key is write-only. `replacingKey` toggles the textarea; when false
  // the stored ciphertext hint is displayed instead.
  const [replacingKey, setReplacingKey] = useState<boolean>(!isExisting);
  const [saKey, setSaKey] = useState<string>('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Re-sync local state when the query returns fresh config (e.g. after
  // save). Keyed on primitives so a roles-list refetch doesn't blow
  // away in-progress edits. Same pattern as sso-page.tsx.
  const configSharedDriveId = config.sharedDriveId;
  const configRootFolderId = config.rootFolderId;
  const configEnabled = config.enabled;
  useEffect(() => {
    setSharedDriveId(configSharedDriveId ?? '');
    setRootFolderId(configRootFolderId ?? '');
    setEnabled(configEnabled);
    setReplacingKey(!isExisting);
    setSaKey('');
  }, [configSharedDriveId, configRootFolderId, configEnabled, isExisting]);

  const upsert = useMutation({
    mutationFn: () =>
      client
        .put('/admin/drive', {
          sharedDriveId: sharedDriveId.trim(),
          rootFolderId: rootFolderId.trim() || null,
          serviceAccountKey: replacingKey && saKey.length > 0 ? saKey : undefined,
          enabled,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'drive'] });
      notify.success('Google Drive configuration saved', { code: 'DRIVE-UPDATE-200' });
      setSaKey('');
      setReplacingKey(false);
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to save Google Drive configuration'),
  });

  const test = useMutation({
    mutationFn: () =>
      client.post('/admin/drive/test').then((r) => r.data.data ?? r.data),
    onMutate: () => setTestResult(null),
    onSuccess: (data: { ok: boolean; driveName?: string; driveId?: string; error?: string }) => {
      if (data.ok) {
        setTestResult({
          ok: true,
          message: `Connected — Shared Drive: ${data.driveName ?? '(unnamed)'}`,
        });
      } else {
        setTestResult({ ok: false, message: data.error ?? 'Unknown error' });
      }
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { message?: string } }; message?: string } | undefined;
      const msg = e?.response?.data?.message ?? e?.message ?? 'Test failed';
      setTestResult({ ok: false, message: String(msg) });
    },
  });

  const canSave =
    canWrite &&
    sharedDriveId.trim().length > 0 &&
    (isExisting || (replacingKey && saKey.length > 0));

  return (
    <div className={cn(card, 'overflow-hidden')}>
      <DriveCardHeader enabled={config.enabled} isExisting={isExisting} />
      <div className="p-5 space-y-5">
        {/* Permission-model note — visible on every visit so the admin
            doesn't confuse "add Planwise integration" with "grant users
            access to my files". */}
        <div className="rounded-lg border border-blue-100 dark:border-blue-900/60 bg-blue-50/70 dark:bg-blue-950/30 p-3 text-[13px] text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Access to files is controlled in Google (Shared Drive membership) — Planwise does not manage permissions. Users open files under their own Google login.
          </span>
        </div>

        <Field label="Shared Drive ID" required>
          <input
            className={monoInputClass}
            value={sharedDriveId}
            onChange={(e) => setSharedDriveId(e.target.value)}
            placeholder="0AGxxxxxxxxxxxxxxUk9PVA"
            disabled={!canWrite}
          />
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            The Google Shared Drive that will hold project folders. Get it from the URL of the Shared Drive in drive.google.com.
          </p>
        </Field>

        <Field label="Root folder ID (optional)">
          <input
            className={monoInputClass}
            value={rootFolderId}
            onChange={(e) => setRootFolderId(e.target.value)}
            placeholder="Leave blank to place project folders at the top of the Shared Drive"
            disabled={!canWrite}
          />
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Optional. When set, project folders are created inside this folder instead of the Shared Drive root.
          </p>
        </Field>

        <Field label="Service account JSON key" required={!isExisting}>
          {replacingKey ? (
            <div className="space-y-2">
              <textarea
                className={textareaClass}
                value={saKey}
                onChange={(e) => setSaKey(e.target.value)}
                placeholder='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n..."}'
                disabled={!canWrite}
                autoComplete="off"
                spellCheck={false}
              />
              {isExisting && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    setReplacingKey(false);
                    setSaKey('');
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {config.keyHint ?? '(none)'}
              </div>
              {canWrite && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => setReplacingKey(true)}
                >
                  Replace key
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Write-only. The stored key is never displayed. Paste the FULL JSON downloaded from Google Cloud Console. Leave blank when saving to keep the current key.
          </p>
        </Field>

        <div className="flex items-center gap-6">
          <Toggle
            label="Enabled"
            description="When on, project pages show 'Open in Drive' buttons and file attach controls."
            checked={enabled}
            onChange={setEnabled}
            disabled={!canWrite}
          />
        </div>

        {testResult && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3 text-[13px]',
              testResult.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300',
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 mt-0.5" />
            )}
            <span className="font-mono tabular-nums">{testResult.message}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 px-5 py-3">
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={!isExisting || test.isPending}
          className={btnSecondary}
        >
          {test.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Test connection
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => upsert.mutate()}
            disabled={!canSave || upsert.isPending}
            className={btnPrimary}
          >
            {upsert.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isExisting ? 'Save changes' : 'Create configuration'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DriveCardHeader({ enabled, isExisting }: { enabled: boolean; isExisting: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-5 py-4">
      <div className="flex items-center gap-3">
        <DriveLogo />
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Google Drive</h2>
          <p className="text-[13px] text-slate-500 dark:text-slate-400">
            Service-account access to a single Shared Drive
          </p>
        </div>
      </div>
      <StatusPill enabled={enabled} isExisting={isExisting} />
    </div>
  );
}

function StatusPill({ enabled, isExisting }: { enabled: boolean; isExisting: boolean }) {
  if (!isExisting) {
    return (
      <span className="text-[11px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-[5px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800">
        Not configured
      </span>
    );
  }
  if (enabled) {
    return (
      <span className="text-[11px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-[5px] text-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50">
        Enabled
      </span>
    );
  }
  return (
    <span className="text-[11px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-[5px] text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50">
      Disabled
    </span>
  );
}

// Simple Drive-branded mark. No external asset (CSP would block it
// anyway); the HardDrive lucide icon is a decent neutral placeholder.
function DriveLogo() {
  return (
    <div className="w-9 h-9 rounded-[7px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
      <HardDrive className="h-4 w-4 text-blue-600 dark:text-blue-400" />
    </div>
  );
}

// ─── Small reusables ───────────────────────────────────────────────

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 mb-1.5 block">
        {label}
        {required && <span className="text-red-500 dark:text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'shrink-0 mt-0.5 relative w-10 h-6 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          checked ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-5 h-5 bg-white dark:bg-slate-100 rounded-full transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </button>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">{label}</div>
        {description && (
          <div className="text-[11px] text-slate-400 dark:text-slate-500">{description}</div>
        )}
      </div>
    </label>
  );
}
