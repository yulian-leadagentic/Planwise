/**
 * Unified notification system — 5 variants matching the design spec
 * in docs/Messeges Examples.png:
 *
 *   success      — green, ~3s auto-dismiss, top-right toast
 *   info         — blue,  ~4s auto-dismiss, top-right toast
 *   warning      — amber, sticky (manual dismiss), top-right alert
 *   validation   — red,   sticky, bullet-list of field issues +
 *                  optional "Review Fields" action button
 *   businessRule — red,   sticky (stickier than warning),
 *                  optional action button + always-visible error
 *                  reference code chip + "Copy details" for support
 *   permission   — neutral card, amber accent + lock, ~8s. "No
 *                  permission" + the server's plain-English reason +
 *                  ref-code chip; no "Copy details" (nothing broke).
 *                  `apiError` picks it for every permission 403.
 *
 * Why one component instead of stock Sonner toasts: the spec needs
 * three different sizes (small / medium / large), richer content
 * (bullet lists, action buttons, code chips), and a "Copy details"
 * affordance on errors so users can paste diagnostic info into
 * support tickets. Sonner's `toast.custom()` lets us render arbitrary
 * JSX while keeping its stacking + positioning + dismissal logic.
 *
 * Backward compat: the existing public API
 *   notify.success / .error / .warning / .info / .apiError / .apiSuccess
 * keeps working unchanged (483+ call sites depend on it). New richer
 * flavors live on `.validation()` and `.businessRule()`.
 */

import { toast as sonnerToast } from 'sonner';
import { useState } from 'react';
import { CheckCircle2, Info as InfoIcon, AlertTriangle, XCircle, Ban, Lock, X, Copy, Check } from 'lucide-react';
import { cn } from './utils';

// ─── Types ─────────────────────────────────────────────────────────────

type Variant = 'success' | 'info' | 'warning' | 'validation' | 'businessRule' | 'permission';

interface BaseOptions {
  /** Error reference code shown as a chip on errors (e.g. "TASK-CREATE-400"). */
  code?: string;
  /** Secondary text under the title. */
  description?: string;
  /** Override default duration in ms. Pass `Infinity` for sticky. */
  duration?: number;
}

/** success / info with an optional action button (e.g. Undo). Same button as businessRule's. */
interface ActionOptions extends BaseOptions {
  action?: { label: string; onClick: () => void };
}

interface ValidationOptions extends BaseOptions {
  /** Bullet-list of field issues displayed under the description. */
  issues?: string[];
  /** Click handler for the "Review Fields" button. When omitted, no button. */
  onReview?: () => void;
}

interface BusinessRuleOptions extends BaseOptions {
  /** Diagnostic payload for the "Copy details" button — usually the
   *  axios error so we can extract method/url/status/body. */
  error?: any;
  /** Custom action button (overrides the default "Copy details"). */
  action?: { label: string; onClick: () => void };
}

// ─── Variant configuration ─────────────────────────────────────────────

const VARIANT_DURATION: Record<Variant, number> = {
  success: 3000,
  info: 4000,
  warning: Infinity,       // sticky
  validation: Infinity,    // sticky
  businessRule: Infinity,  // stickier than warning per spec — both Infinity, but BR has Copy details so user dismisses last
  permission: 8000,        // informative, not a failure — long enough to read, never piles up
};

// Tailwind classes per variant. Order: container bg, container border,
// icon color, title color, description color.
const VARIANT_STYLES: Record<Variant, {
  bg: string;
  border: string;
  iconWrap: string;
  iconColor: string;
  title: string;
  body: string;
  Icon: React.FC<{ className?: string }>;
}> = {
  success:      { bg: 'bg-emerald-50', border: 'border-emerald-200', iconWrap: 'bg-emerald-100', iconColor: 'text-emerald-700', title: 'text-emerald-900', body: 'text-emerald-800', Icon: CheckCircle2 },
  info:         { bg: 'bg-blue-50',    border: 'border-blue-200',    iconWrap: 'bg-blue-100',    iconColor: 'text-blue-700',    title: 'text-blue-900',    body: 'text-blue-800',    Icon: InfoIcon },
  warning:      { bg: 'bg-amber-50',   border: 'border-amber-200',   iconWrap: 'bg-amber-100',   iconColor: 'text-amber-700',   title: 'text-amber-900',   body: 'text-amber-800',   Icon: AlertTriangle },
  validation:   { bg: 'bg-red-50',     border: 'border-red-200',     iconWrap: 'bg-red-100',     iconColor: 'text-red-700',     title: 'text-red-900',     body: 'text-red-800',     Icon: XCircle },
  businessRule: { bg: 'bg-red-50',     border: 'border-red-300',     iconWrap: 'bg-red-100',     iconColor: 'text-red-800',     title: 'text-red-900',     body: 'text-red-800',     Icon: Ban },
  // Not an error: neutral surface, amber left accent (toast rule in the
  // design system) and a lock — "you may not", not "something broke".
  permission:   { bg: 'bg-white dark:bg-slate-900', border: 'border-slate-200 dark:border-slate-700 border-l-[3px] border-l-amber-500 dark:border-l-amber-500', iconWrap: 'bg-amber-50 dark:bg-amber-500/10', iconColor: 'text-amber-600 dark:text-amber-400', title: 'text-slate-900 dark:text-slate-100', body: 'text-slate-600 dark:text-slate-300', Icon: Lock },
};

// ─── Diagnostic payload (Copy details) ─────────────────────────────────

/**
 * Build a structured plain-text "diagnostic packet" the user can paste
 * into a support ticket. Includes the error code, the request that
 * failed (method/URL), the HTTP status + response body, a timestamp,
 * and the browser's user-agent so we can reproduce.
 */
function buildDiagnosticDetails(opts: { code?: string; title: string; description?: string; error?: any }): string {
  const lines: string[] = [];
  lines.push(`Planwise diagnostic — share this with support`);
  lines.push(`Time:   ${new Date().toISOString()}`);
  lines.push(`Code:   ${opts.code ?? '(none)'}`);
  lines.push(`Title:  ${opts.title}`);
  if (opts.description) lines.push(`Detail: ${opts.description}`);
  const err = opts.error;
  if (err) {
    const method = (err?.config?.method || err?.response?.config?.method || '').toUpperCase();
    const url = err?.config?.url || err?.response?.config?.url;
    const status = err?.response?.status;
    if (method && url) lines.push(`Request: ${method} ${url}`);
    if (status) lines.push(`Status:  ${status}`);
    const body = err?.response?.data;
    if (body) {
      try {
        const serialized = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        lines.push(`Response body:`);
        lines.push(serialized.length > 2000 ? serialized.slice(0, 2000) + '\n…[truncated]' : serialized);
      } catch {
        /* non-serializable — skip */
      }
    }
  }
  lines.push(`User agent: ${navigator.userAgent}`);
  lines.push(`URL: ${window.location.href}`);
  return lines.join('\n');
}

// ─── Card component ────────────────────────────────────────────────────

interface CardProps {
  variant: Variant;
  title: string;
  description?: string;
  code?: string;
  issues?: string[];
  /** Primary action button (e.g. "Review Fields", "Download report"). */
  action?: { label: string; onClick: () => void };
  /** Pre-built diagnostic text. When present, a "Copy details" button shows. */
  copyDetails?: string;
  /** Called to dismiss the toast. */
  onDismiss: () => void;
}

function NotificationCard({ variant, title, description, code, issues, action, copyDetails, onDismiss }: CardProps) {
  const v = VARIANT_STYLES[variant];
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!copyDetails) return;
    try {
      await navigator.clipboard.writeText(copyDetails);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — fall back to opening a textarea? for v1, swallow */
    }
  };

  return (
    <div
      role={variant === 'success' || variant === 'info' ? 'status' : 'alert'}
      className={cn(
        'flex items-start gap-3 rounded-lg border shadow-sm pointer-events-auto',
        'min-w-[320px] max-w-[420px] p-3 pr-4',
        v.bg, v.border,
      )}
    >
      {/* Icon */}
      <div className={cn('flex h-7 w-7 items-center justify-center rounded-full shrink-0 mt-0.5', v.iconWrap)}>
        <v.Icon className={cn('h-4 w-4', v.iconColor)} />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <p className={cn('text-[13px] font-semibold leading-snug', v.title)}>{title}</p>

        {description && (
          <p className={cn('mt-0.5 text-[12px] leading-snug', v.body)}>{description}</p>
        )}

        {/* Bullet list of field issues (validation variant) */}
        {issues && issues.length > 0 && (
          <ul className={cn('mt-1.5 list-disc list-inside text-[12px] space-y-0.5', v.body)}>
            {issues.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        )}

        {/* Action button row + Copy details + Code chip */}
        {(action || copyDetails || code) && (
          <div className="mt-2 flex items-center flex-wrap gap-2">
            {action && (
              <button
                type="button"
                onClick={() => { action.onClick(); onDismiss(); }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                  variant === 'success' && 'border-emerald-300 bg-white dark:bg-slate-900 text-emerald-800 hover:bg-emerald-100',
                  variant === 'info' && 'border-blue-300 bg-white dark:bg-slate-900 text-blue-800 hover:bg-blue-100',
                  variant === 'warning' && 'border-amber-300 bg-white dark:bg-slate-900 text-amber-800 hover:bg-amber-100',
                  (variant === 'validation' || variant === 'businessRule') && 'border-red-300 bg-white dark:bg-slate-900 text-red-800 hover:bg-red-100',
                )}
              >
                {action.label}
              </button>
            )}
            {copyDetails && (
              <button
                type="button"
                onClick={handleCopy}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors',
                  'text-red-800 hover:bg-red-100',
                )}
                title="Copy diagnostic details (paste into your support ticket)"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy details'}
              </button>
            )}
            {code && (
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] font-mono font-bold tracking-wider uppercase',
                  variant === 'success' && 'bg-emerald-100 text-emerald-800',
                  variant === 'info' && 'bg-blue-100 text-blue-800',
                  variant === 'warning' && 'bg-amber-100 text-amber-800',
                  (variant === 'validation' || variant === 'businessRule') && 'bg-red-100 text-red-800',
                  variant === 'permission' && 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
                )}
                title="Reference code — quote this when contacting support"
              >
                Ref: {code}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Dismiss button */}
      <button
        type="button"
        onClick={onDismiss}
        className={cn('shrink-0 rounded p-0.5 -mr-1 -mt-0.5 transition-colors hover:bg-black/5', v.body)}
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Renderer ──────────────────────────────────────────────────────────

function render(
  variant: Variant,
  title: string,
  opts: BaseOptions & {
    issues?: string[];
    action?: { label: string; onClick: () => void };
    copyDetails?: string;
    /** Stable Sonner id — a second toast with the same id replaces the first. */
    id?: string;
  } = {},
): string | number {
  const duration = opts.duration ?? VARIANT_DURATION[variant];
  return sonnerToast.custom(
    (t) => (
      <NotificationCard
        variant={variant}
        title={title}
        description={opts.description}
        code={opts.code}
        issues={opts.issues}
        action={opts.action}
        copyDetails={opts.copyDetails}
        onDismiss={() => sonnerToast.dismiss(t)}
      />
    ),
    {
      // Sonner accepts Infinity for sticky — alias undefined removes
      // the default timer.
      duration: duration === Infinity ? undefined : duration,
      ...(opts.id ? { id: opts.id } : {}),
    },
  );
}

// ─── Error-code + message extraction (preserved from prior notify.ts) ──

export function getErrorCode(error: any, fallbackModule = 'APP', fallbackAction = 'UNKNOWN'): string {
  const status = error?.response?.status || error?.status || 0;
  const url = error?.config?.url || error?.response?.config?.url || '';
  const method = (error?.config?.method || error?.response?.config?.method || 'GET').toUpperCase();
  const pathParts = url.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  const module = (pathParts[0] || fallbackModule)
    .replace(/-/g, '_')
    .toUpperCase()
    .replace(/S$/, '');
  const actionMap: Record<string, string> = {
    GET: 'FETCH', POST: 'CREATE', PATCH: 'UPDATE', PUT: 'UPDATE', DELETE: 'DELETE',
  };
  const action = actionMap[method] || fallbackAction;
  return `${module}-${action}-${status || 'ERR'}`;
}

// ─── API error envelope ────────────────────────────────────────────────

/** Just enough of an axios error to reach the envelope. */
type ApiErrorLike =
  | { response?: { data?: { error?: { code?: unknown; details?: unknown } } } }
  | null
  | undefined;

/**
 * The stable code from the API's error envelope
 * `{ success: false, error: { code, message, details } }` — a business
 * code such as MONTHLY_NOT_YET_COMPUTED / CROSS_TASK_OVERLAP /
 * PERMISSION_DENIED, or the status-derived one (BAD_REQUEST, CONFLICT …).
 * Null for network errors or a body without the envelope. (2026-11-20)
 */
export function apiErrorCode(error: unknown): string | null {
  const code = (error as ApiErrorLike)?.response?.data?.error?.code;
  return typeof code === 'string' && code ? code : null;
}

/** The envelope's `error.details` payload (e.g. the conflicts of a CROSS_TASK_OVERLAP), or null. */
export function apiErrorDetails<T = unknown>(error: unknown): T | null {
  const details = (error as ApiErrorLike)?.response?.data?.error?.details;
  return details == null ? null : (details as T);
}

/** Envelope code of a 400 that lists the required fields it found empty. */
export const MISSING_REQUIRED_FIELDS_CODE = 'MISSING_REQUIRED_FIELDS';

/**
 * The field names of a MISSING_REQUIRED_FIELDS 400 (`error.details.missing`,
 * e.g. ['zoneId']), or null for any other error. (2026-11-21)
 */
export function apiMissingFields(error: unknown): string[] | null {
  if (apiErrorCode(error) !== MISSING_REQUIRED_FIELDS_CODE) return null;
  const missing = apiErrorDetails<{ missing?: unknown }>(error)?.missing;
  if (!Array.isArray(missing)) return null;
  const fields = missing.filter((k): k is string => typeof k === 'string' && k.length > 0);
  return fields.length > 0 ? fields : null;
}

// ─── Permission 403s ───────────────────────────────────────────────────

/** Envelope code the API puts on every "you may not do this" 403. */
export const PERMISSION_DENIED_CODE = 'PERMISSION_DENIED';

const GENERIC_NO_PERMISSION = "You don't have permission to do this. Ask your administrator for access.";

/**
 * True for a permission refusal: the API's `PERMISSION_DENIED` code, or a
 * plain 403 without a business-rule code of its own (an older API build,
 * Nest's default "Forbidden resource"). A 403 that carries its own code —
 * e.g. ROLE_IS_SYSTEM (built-in roles can't be renamed) — is a rule, not
 * a permission, and keeps the regular error alert.
 */
export function isPermissionDenied(error: any): boolean {
  const code = apiErrorCode(error);
  if (code === PERMISSION_DENIED_CODE) return true;
  const status = error?.response?.status ?? error?.status;
  return status === 403 && (code == null || code === 'FORBIDDEN');
}

/** The server's plain-English reason for a permission 403 (never axios' "Request failed with status code 403"). */
export function getPermissionMessage(error: any): string {
  const data = error?.response?.data;
  const msg = data?.error?.message ?? data?.message;
  if (typeof msg === 'string' && msg.trim() && msg !== 'Forbidden resource' && msg !== 'Forbidden') {
    return msg;
  }
  return GENERIC_NO_PERMISSION;
}

export function getErrorMessage(error: any, fallback = 'An unexpected error occurred'): string {
  if (error?.response?.data?.error?.message) return error.response.data.error.message;
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.message && error.message !== 'Network Error') return error.message;
  if (error?.message === 'Network Error') return 'Unable to connect to server. Please check your connection.';
  return fallback;
}

// ─── Public API ────────────────────────────────────────────────────────

export const notify = {
  // ─ Simple toasts ────────────────────────────────────────────────────
  // An `action` adds a button (QA6 P4: the Workload move's Undo); a click
  // runs it and closes the toast, as businessRule's action does.
  success: (title: string, options?: ActionOptions) => render('success', title, options),
  info:    (title: string, options?: ActionOptions) => render('info',    title, options),
  warning: (title: string, options?: BaseOptions) => render('warning', title, options),

  // ─ Error — kept as a public method for back-compat (483 call sites)
  // Routes to businessRule under the hood so any existing notify.error()
  // call gains the Copy details + ref-code chip automatically.
  error: (title: string, options?: BaseOptions & { error?: any }) =>
    render('businessRule', title, {
      ...options,
      copyDetails: buildDiagnosticDetails({
        code: options?.code,
        title,
        description: options?.description,
        error: options?.error,
      }),
    }),

  // ─ Validation — list of field issues, optional Review Fields action ─
  validation: (title: string, options?: ValidationOptions) => render('validation', title, {
    ...options,
    action: options?.onReview ? { label: 'Review Fields', onClick: options.onReview } : undefined,
  }),

  // ─ Business rule error — modal-ish alert with Copy details ──────────
  businessRule: (title: string, options?: BusinessRuleOptions) => render('businessRule', title, {
    code: options?.code,
    description: options?.description,
    duration: options?.duration,
    action: options?.action,
    copyDetails: buildDiagnosticDetails({
      code: options?.code,
      title,
      description: options?.description,
      error: options?.error,
    }),
  }),

  // ─ apiError — extracts code + message from an axios error and surfaces
  // it as a businessRule alert. Heuristic: if the response body has an
  // array of validation `details`, route to .validation() instead.
  apiError: (error: any, fallbackMessage = 'Operation failed', module?: string, action?: string) => {
    const code = getErrorCode(error, module, action);

    // Permission refusal (403) — not a crash: "No permission" + the
    // server's reason, lock icon, ref chip, no "Copy details". The id
    // collapses repeats of the same refusal into one card.
    if (isPermissionDenied(error)) {
      const description = getPermissionMessage(error);
      return render('permission', 'No permission', { code, description, id: `permission:${description}` });
    }

    const message = getErrorMessage(error, fallbackMessage);

    // Structured MISSING_REQUIRED_FIELDS 400 — surface each missing
    // field as a bullet so the user can pinpoint what to fix even when
    // the calling form doesn't wire inline errors. (Ops backlog #2,
    // 2026-08-08 — matches the core-task guardrail in tasks.service.)
    // 2026-11-21: read from the envelope's `details.missing`; the old
    // top-level `error` / `missing` keys never survived the API filter.
    // "is required" (not "…for core tasks") — personal tasks use it too.
    const missing = apiMissingFields(error);
    if (missing) {
      const labels: Record<string, string> = {
        serviceTypeId: 'Service',
        zoneId: 'Zone',
        projectDeliverableId: 'Deliverable (project or template)',
        deliverableTemplateId: 'Deliverable (template)',
        requiresReview: 'Review flag (yes / no)',
      };
      const issues = missing.map((k) => `${labels[k] ?? k} is required`);
      return render('validation', message || 'Missing required fields', { code, issues });
    }

    // Validation-shaped responses (NestJS ValidationPipe returns
    // { details: string[] } in the envelope). Show as bullet list.
    const details = apiErrorDetails(error) ?? error?.response?.data?.details;
    if (Array.isArray(details) && details.length > 0) {
      return render('validation', message, { code, issues: details.map(String) });
    }

    return render('businessRule', message, {
      code,
      copyDetails: buildDiagnosticDetails({ code, title: message, error }),
    });
  },

  // Convenience: show success for API mutations
  apiSuccess: (message: string, module?: string, action?: string) => {
    const code = module && action ? `${module}-${action}-200` : undefined;
    return render('success', message, { code });
  },

  /** Programmatically dismiss a notification by id (the value returned
   *  from any notify.* call). Useful for clearing optimistic toasts. */
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};

export default notify;
