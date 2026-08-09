/**
 * Admin -> SSO / Identity page.
 *
 * Phase 1 covers Microsoft Entra ID; Google is rendered as a disabled
 * "Coming in P2" placeholder card. Only users with org:write can hit
 * the write endpoints; org:read gates the view.
 *
 * The client secret is write-only across the API and the UI. We show
 * "•••4a2b" (a fingerprint from the ciphertext, never from plaintext)
 * next to a "Replace secret" button. Clicking it reveals an input;
 * saving with the field blank preserves the stored secret.
 *
 * Read-only helper block shows the exact redirect_uri the admin must
 * register in Entra (`{API_BASE}/api/v1/auth/oidc/microsoft/callback`)
 * with a copy button, plus the required scopes.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Check, ShieldCheck, Loader2, Info, XCircle, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { API_BASE } from '@/lib/runtime-config';

// ─── Types (mirror the API response shape) ─────────────────────────

interface SsoConfigView {
  provider: string;
  enabled: boolean;
  tenantId: string | null;
  clientId: string;
  hasSecret: boolean;
  secretHint: string | null;
  allowedDomains: string;
  defaultRoleId: number;
  ssoOnly: boolean;
  keyVersion: number;
  updatedAt: string;
}

interface RoleOption {
  id: number;
  name: string;
  description?: string | null;
}

// Design-system tokens reused from the roles page.
const inputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none';

const monoInputClass =
  'w-full px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 focus-visible:border-blue-500 focus:outline-none';

const btnPrimary =
  'bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5';

const btnSecondary =
  'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 text-slate-700 dark:text-slate-200 text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5';

const card =
  'bg-white dark:bg-slate-900 rounded-[14px] border border-slate-200 dark:border-slate-700';

// ─── Page shell ───────────────────────────────────────────────────

export function SsoPage() {
  const { can } = usePermissions();
  const canRead = can('org', 'read');
  const canWrite = can('org', 'write');

  const { data: configs = [], isLoading } = useQuery<SsoConfigView[]>({
    queryKey: ['admin', 'sso'],
    enabled: canRead,
    staleTime: 60_000,
    queryFn: () => client.get('/admin/sso').then((r) => r.data.data ?? r.data),
  });

  const { data: roles = [] } = useQuery<RoleOption[]>({
    queryKey: ['admin', 'roles'],
    enabled: canRead,
    staleTime: 5 * 60 * 1000,
    queryFn: () => client.get('/admin/roles').then((r) => r.data.data ?? r.data),
  });

  if (!canRead) {
    return (
      <div className={cn(card, 'p-8 text-center')}>
        <ShieldCheck className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
        <h3 className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          You don't have permission to view SSO settings
        </h3>
        <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">
          Ask an administrator to grant you the "org" module read permission.
        </p>
      </div>
    );
  }

  const microsoft = configs.find((c) => c.provider === 'microsoft') ?? null;
  // Placeholder for a not-yet-configured provider so the card can
  // render defaults without an API round-trip.
  const microsoftDraft: SsoConfigView = microsoft ?? {
    provider: 'microsoft',
    enabled: false,
    tenantId: '',
    clientId: '',
    hasSecret: false,
    secretHint: null,
    allowedDomains: '',
    defaultRoleId: roles[0]?.id ?? 0,
    ssoOnly: false,
    keyVersion: 0,
    updatedAt: new Date().toISOString(),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="SSO / Identity"
        description="Enterprise single sign-on for your organization."
      />

      {isLoading ? (
        <div className={cn(card, 'h-64 animate-pulse')} />
      ) : (
        <div className="space-y-4">
          <MicrosoftCard config={microsoftDraft} roles={roles} canWrite={canWrite} isExisting={!!microsoft} />
          <GooglePlaceholderCard />
        </div>
      )}
    </div>
  );
}

// ─── Microsoft card ───────────────────────────────────────────────

interface CardProps {
  config: SsoConfigView;
  roles: RoleOption[];
  canWrite: boolean;
  isExisting: boolean;
}

function MicrosoftCard({ config, roles, canWrite, isExisting }: CardProps) {
  const queryClient = useQueryClient();
  const [tenantId, setTenantId] = useState(config.tenantId ?? '');
  const [clientId, setClientId] = useState(config.clientId ?? '');
  const [allowedDomains, setAllowedDomains] = useState(config.allowedDomains ?? '');
  const [defaultRoleId, setDefaultRoleId] = useState<number>(config.defaultRoleId);
  const [ssoOnly, setSsoOnly] = useState<boolean>(config.ssoOnly);
  const [enabled, setEnabled] = useState<boolean>(config.enabled);
  // Secret is write-only. `replacingSecret` toggles the input; when
  // false the stored ciphertext hint is displayed instead.
  const [replacingSecret, setReplacingSecret] = useState<boolean>(!isExisting);
  const [secret, setSecret] = useState<string>('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Re-sync local state when the query returns a fresh config (e.g.
  // after a successful save). Keyed on (provider, updatedAt) so a
  // roles-list refresh does NOT blow away in-progress edits — the
  // dependency list stays tight even though `config` itself is a new
  // object on every render.
  const configTenantId = config.tenantId;
  const configClientId = config.clientId;
  const configAllowedDomains = config.allowedDomains;
  const configDefaultRoleId = config.defaultRoleId;
  const configSsoOnly = config.ssoOnly;
  const configEnabled = config.enabled;
  useEffect(() => {
    setTenantId(configTenantId ?? '');
    setClientId(configClientId ?? '');
    setAllowedDomains(configAllowedDomains ?? '');
    setDefaultRoleId(configDefaultRoleId);
    setSsoOnly(configSsoOnly);
    setEnabled(configEnabled);
    setReplacingSecret(!isExisting);
    setSecret('');
  }, [
    configTenantId,
    configClientId,
    configAllowedDomains,
    configDefaultRoleId,
    configSsoOnly,
    configEnabled,
    isExisting,
  ]);

  const upsert = useMutation({
    mutationFn: () =>
      client
        .put(`/admin/sso/microsoft`, {
          tenantId: tenantId.trim() || null,
          clientId: clientId.trim(),
          secret: replacingSecret && secret.length > 0 ? secret : undefined,
          allowedDomains: allowedDomains.trim(),
          defaultRoleId,
          ssoOnly,
          enabled,
        })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'sso'] });
      notify.success('SSO configuration saved', { code: 'SSO-UPDATE-200' });
      setSecret('');
      setReplacingSecret(false);
    },
    onError: (err: unknown) => notify.apiError(err, 'Failed to save SSO configuration'),
  });

  const test = useMutation({
    mutationFn: () => client.post(`/admin/sso/microsoft/test`).then((r) => r.data.data ?? r.data),
    onMutate: () => setTestResult(null),
    onSuccess: (data: { ok: boolean; discovery?: { issuer?: string }; error?: string }) => {
      if (data.ok) {
        setTestResult({ ok: true, message: `Connected — issuer: ${data.discovery?.issuer ?? '(unknown)'}` });
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
    tenantId.trim().length > 0 &&
    clientId.trim().length > 0 &&
    defaultRoleId > 0 &&
    (isExisting || (replacingSecret && secret.length > 0));

  return (
    <div className={cn(card, 'overflow-hidden')}>
      <MicrosoftCardHeader enabled={config.enabled} isExisting={isExisting} />
      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Tenant ID" required>
            <input
              className={monoInputClass}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              disabled={!canWrite}
            />
          </Field>
          <Field label="Client ID (Application ID)" required>
            <input
              className={monoInputClass}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              disabled={!canWrite}
            />
          </Field>
        </div>

        <Field label="Client secret" required={!isExisting}>
          {replacingSecret ? (
            <div className="flex items-center gap-2">
              <input
                type="password"
                className={monoInputClass}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Paste the client-secret VALUE from the Entra portal"
                disabled={!canWrite}
                autoComplete="new-password"
              />
              {isExisting && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    setReplacingSecret(false);
                    setSecret('');
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {config.secretHint ?? '(none)'}
              </div>
              {canWrite && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => setReplacingSecret(true)}
                >
                  Replace secret
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Write-only. The stored secret is never displayed. Leave blank when saving to keep the current secret.
          </p>
        </Field>

        <Field label="Allowed email domains" required>
          <input
            className={inputClass}
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
            placeholder="acme.com, corp.acme.io"
            disabled={!canWrite}
          />
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            Comma-separated. A user is JIT-created only when their verified email domain is on this list.
          </p>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Default role for new users" required>
            <select
              className={inputClass}
              value={defaultRoleId}
              onChange={(e) => setDefaultRoleId(Number(e.target.value))}
              disabled={!canWrite}
            >
              <option value={0} disabled>
                Select a role…
              </option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex flex-col gap-3 justify-end pb-1">
            <Toggle
              label="SSO only"
              description="Users flagged as SSO-only cannot use password login."
              checked={ssoOnly}
              onChange={setSsoOnly}
              disabled={!canWrite}
            />
            <Toggle
              label="Enabled"
              description="Show 'Sign in with Microsoft' on the login page."
              checked={enabled}
              onChange={setEnabled}
              disabled={!canWrite}
            />
          </div>
        </div>

        <RedirectUriBlock provider="microsoft" />

        {testResult && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border p-3 text-[13px]',
              testResult.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300',
            )}
          >
            {testResult.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5" /> : <XCircle className="h-4 w-4 mt-0.5" />}
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
          {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
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

function MicrosoftCardHeader({ enabled, isExisting }: { enabled: boolean; isExisting: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-5 py-4">
      <div className="flex items-center gap-3">
        <MicrosoftLogo />
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Microsoft Entra ID</h2>
          <p className="text-[13px] text-slate-500 dark:text-slate-400">
            OpenID Connect via login.microsoftonline.com
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

// Simple 4-square Microsoft logomark using their brand palette. No
// external asset (CSP would block a remote SVG anyway).
function MicrosoftLogo() {
  return (
    <div className="w-9 h-9 rounded-[7px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 grid grid-cols-2 gap-[2px] p-1">
      <div className="bg-[#F25022]" />
      <div className="bg-[#7FBA00]" />
      <div className="bg-[#00A4EF]" />
      <div className="bg-[#FFB900]" />
    </div>
  );
}

// ─── Google placeholder ────────────────────────────────────────────

function GooglePlaceholderCard() {
  return (
    <div className={cn(card, 'opacity-60')}>
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-[7px] bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 font-bold text-sm">
            G
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Google Workspace</h2>
            <p className="text-[13px] text-slate-500 dark:text-slate-400">
              Coming in P2 — sign-in via accounts.google.com
            </p>
          </div>
        </div>
        <span className="text-[11px] font-bold tracking-wide uppercase px-2 py-0.5 rounded-[5px] text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800">
          Coming in P2
        </span>
      </div>
      <div className="p-5">
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-950/40 p-3 text-[13px] text-slate-500 dark:text-slate-400">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Google SSO isn't available yet. If you need it now, use Microsoft SSO or password login.
          </span>
        </div>
      </div>
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

function RedirectUriBlock({ provider }: { provider: string }) {
  const redirectUri = useMemo(() => {
    const base = (API_BASE && API_BASE.length > 0 ? API_BASE : window.location.origin).replace(/\/$/, '');
    return `${base}/api/v1/auth/oidc/${provider}/callback`;
  }, [provider]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Ignore — some browsers block writeText without user gesture
      // in insecure contexts. The URL is still visible.
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-950/40 p-3 space-y-2.5">
      <div className="flex items-start gap-2 text-[13px] text-slate-600 dark:text-slate-300">
        <Info className="h-4 w-4 mt-0.5 text-slate-400 dark:text-slate-500 shrink-0" />
        <div>
          Register this exact redirect URI in the Entra portal under{' '}
          <span className="font-semibold">Authentication → Redirect URIs (Web)</span>.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-200 truncate">
          {redirectUri}
        </code>
        <button type="button" onClick={copy} className={btnSecondary}>
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">
        Required scopes: <span className="font-mono tabular-nums">openid profile email</span>
      </div>
    </div>
  );
}
