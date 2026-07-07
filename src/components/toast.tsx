"use client";

import { createContext, useContext, useCallback, useState } from "react";

type Toast = { id: number; message: string; ok: boolean };
type ToastContextValue = (message: string, ok: boolean) => void;

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  // No-op fallback so components don't crash outside a provider.
  return ctx ?? (() => {});
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback<ToastContextValue>((message, ok) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, ok }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg animate-[fadeIn_0.15s_ease-out] ${
              t.ok
                ? "border-green-200 bg-green-50 text-green-900"
                : "border-red-200 bg-red-50 text-red-900"
            }`}
          >
            <span className="mr-2">{t.ok ? "✓" : "⚠"}</span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
