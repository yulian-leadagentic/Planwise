import { toast as sonnerToast } from 'sonner';

// Error code format: [MODULE]-[ACTION]-[HTTP_STATUS]
// Examples: TASK-CREATE-400, ZONE-DELETE-500, AUTH-LOGIN-401

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface NotifyOptions {
  code?: string;
  description?: string;
  duration?: number;
}

// Generate error code from API error
export function getErrorCode(error: any, fallbackModule = 'APP', fallbackAction = 'UNKNOWN'): string {
  const status = error?.response?.status || error?.status || 0;
  const url = error?.config?.url || error?.response?.config?.url || '';
  const method = (error?.config?.method || error?.response?.config?.method || 'GET').toUpperCase();

  // Extract module from URL: /api/v1/tasks/123 → TASK
  const pathParts = url.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  const module = (pathParts[0] || fallbackModule)
    .replace(/-/g, '_')
    .toUpperCase()
    .replace(/S$/, ''); // plural → singular

  // Map method to action
  const actionMap: Record<string, string> = {
    GET: 'FETCH',
    POST: 'CREATE',
    PATCH: 'UPDATE',
    PUT: 'UPDATE',
    DELETE: 'DELETE',
  };
  const action = actionMap[method] || fallbackAction;

  return `${module}-${action}-${status || 'ERR'}`;
}

// Extract error message from API error
export function getErrorMessage(error: any, fallback = 'An unexpected error occurred'): string {
  if (error?.response?.data?.error?.message) return error.response.data.error.message;
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.message && error.message !== 'Network Error') return error.message;
  if (error?.message === 'Network Error') return 'Unable to connect to server. Please check your connection.';
  return fallback;
}

// Custom toast rendering with error codes
function renderToast(type: ToastType, title: string, options?: NotifyOptions) {
  const { code, description, duration } = options || {};

  const message = code
    ? `${title}\n\nRef: ${code}`
    : title;

  const toastOptions = {
    description: description || undefined,
    duration: duration || (type === 'error' ? 6000 : type === 'warning' ? 5000 : 4000),
  };

  switch (type) {
    case 'success':
      return sonnerToast.success(message, toastOptions);
    case 'error':
      return sonnerToast.error(message, toastOptions);
    case 'warning':
      return sonnerToast.warning(message, toastOptions);
    case 'info':
      return sonnerToast.info(message, toastOptions);
  }
}

// Public API
export const notify = {
  success: (title: string, options?: NotifyOptions) =>
    renderToast('success', title, options),

  error: (title: string, options?: NotifyOptions) =>
    renderToast('error', title, options),

  warning: (title: string, options?: NotifyOptions) =>
    renderToast('warning', title, options),

  info: (title: string, options?: NotifyOptions) =>
    renderToast('info', title, options),

  // Convenience: extract error from API error object and show toast
  apiError: (error: any, fallbackMessage = 'Operation failed', module?: string, action?: string) => {
    const code = getErrorCode(error, module, action);
    const message = getErrorMessage(error, fallbackMessage);
    return renderToast('error', message, { code });
  },

  // Convenience: show success for API mutations
  apiSuccess: (message: string, module?: string, action?: string) => {
    const code = module && action ? `${module}-${action}-200` : undefined;
    return renderToast('success', message, { code });
  },
};

export default notify;
