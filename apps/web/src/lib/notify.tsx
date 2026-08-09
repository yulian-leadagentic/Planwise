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
import { CheckCircle2, Info as InfoIcon, AlertTriangle, XCircle, Ban, X, Copy, Check } from 'lucide-react';
import { cn } from './utils';

// ─── Types ─────────────────────────────────────────────────────────────

type Variant = 'success' | 'info' | 'warning' | 'validation' | 'businessRule';

interface BaseOptions {
  /** Error reference code shown as a chip on errors (e.g. "TASK-CREATE-400"). */
  code?: string;
  /** Secondary text under the title. */
  description?: string;
  /** Override default duration in ms. Pass `Infinity` for sticky. */
  duration?: number;
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
  success: (title: string, options?: BaseOptions) => render('success', title, options),
  info:    (title: string, options?: BaseOptions) => render('info',    title, options),
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
    const message = getErrorMessage(error, fallbackMessage);

    // Structured "missing_required_fields" 400 — surface each missing
    // field as a bullet so the user can pinpoint what to fix even when
    // the calling form doesn't wire inline errors. (Ops backlog #2,
    // 2026-08-08 — matches the core-task guardrail in tasks.service.)
    const body = error?.response?.data;
    if (body?.error === 'missing_required_fields' && Array.isArray(body.missing) && body.missing.length > 0) {
      const labels: Record<string, string> = {
        serviceTypeId: 'Service',
        zoneId: 'Zone',
        projectDeliverableId: 'Deliverable (project or template)',
        deliverableTemplateId: 'Deliverable (template)',
        requiresReview: 'Review flag (yes / no)',
      };
      const issues = body.missing.map((k: string) => `${labels[k] ?? k} is required for core tasks`);
      return render('validation', message || 'Missing required fields', { code, issues });
    }

    // Validation-shaped responses (NestJS ValidationPipe returns
    // { details: string[] } in the envelope). Show as bullet list.
    const details = error?.response?.data?.error?.details
      ?? error?.response?.data?.details;
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
