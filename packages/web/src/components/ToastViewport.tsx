import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastPayload {
  variant: ToastVariant;
  title: string;
  description?: string;
  duration?: number;
}

export interface ToastItem extends ToastPayload {
  id: number;
}

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

const variantStyles: Record<ToastVariant, string> = {
  info: "border-slate-200 bg-white/95 text-slate-900 dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-100",
  success:
    "border-emerald-200 bg-emerald-50/95 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-100",
  warning:
    "border-amber-200 bg-amber-50/95 text-amber-900 dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-100",
  error: "border-red-200 bg-red-50/95 text-red-900 dark:border-red-800 dark:bg-red-950/90 dark:text-red-100",
};

const iconStyles: Record<ToastVariant, string> = {
  info: "text-slate-500 dark:text-slate-300",
  success: "text-emerald-600 dark:text-emerald-300",
  warning: "text-amber-600 dark:text-amber-300",
  error: "text-red-600 dark:text-red-300",
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  switch (variant) {
    case "success":
      return <CheckCircle2 className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconStyles[variant]}`} />;
    case "warning":
      return <AlertTriangle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconStyles[variant]}`} />;
    case "error":
      return <XCircle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconStyles[variant]}`} />;
    default:
      return <Info className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconStyles[variant]}`} />;
  }
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timeout = toast.duration ?? 5000;
    if (timeout <= 0) return;

    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, timeout);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toast.duration, toast.id, onDismiss]);
  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`toast-enter pointer-events-auto w-[min(24rem,calc(100vw-2rem))] rounded-xl border shadow-lg backdrop-blur ${variantStyles[toast.variant]}`}
    >
      <div className="flex items-start gap-3 p-4">
        <ToastIcon variant={toast.variant} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-5">{toast.title}</div>
          {toast.description ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 opacity-90">
              {toast.description}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="rounded-md p-1 opacity-60 transition-opacity hover:opacity-100"
          aria-label="关闭通知"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function ToastViewport({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex max-w-full flex-col gap-3">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
