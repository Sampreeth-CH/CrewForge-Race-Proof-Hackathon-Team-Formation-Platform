import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      setTimeout(() => {
        dismiss(id);
      }, 4500);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="flex items-start gap-3 rounded-lg border border-white/10 bg-[#131722] p-3.5 text-sm shadow-xl"
          >
            {t.variant === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />}
            {t.variant === 'error' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />}
            {t.variant === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />}
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-100">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs text-slate-400">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="rounded p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
