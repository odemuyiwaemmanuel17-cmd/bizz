import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  /** Auto-dismiss delay in ms. Defaults to 3800 (errors linger a bit longer). */
  readonly durationMs?: number;
}

interface ToastRecord {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly tone: ToastTone;
  readonly durationMs: number;
}

export interface ToastApi {
  readonly push: (input: ToastInput) => void;
  readonly dismiss: (id: number) => void;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

const noopApi: ToastApi = Object.freeze({
  push: (): void => undefined,
  dismiss: (): void => undefined,
});

const ToastContext = createContext<ToastApi>(noopApi);

/** Access the global toast API. Safe outside a provider (no-op fallback). */
export function useToast(): ToastApi {
  return useContext<ToastApi>(ToastContext);
}

const MAX_VISIBLE = 4;

function defaultDuration(tone: ToastTone): number {
  if (tone === "error") return 5200;
  return 3800;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

interface ToastProviderProps {
  readonly children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps): ReactElement {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastRecord>>([]);
  const nextIdRef = useRef<number>(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number): void => {
    const timer: ReturnType<typeof setTimeout> | undefined = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number): void => {
      clearTimer(id);
      setToasts((prev: ReadonlyArray<ToastRecord>): ReadonlyArray<ToastRecord> =>
        prev.filter((toast: ToastRecord): boolean => toast.id !== id),
      );
    },
    [clearTimer],
  );

  const push = useCallback(
    (input: ToastInput): void => {
      const tone: ToastTone = input.tone ?? "info";
      const duration: number = Math.max(1200, input.durationMs ?? defaultDuration(tone));
      const record: ToastRecord = Object.freeze({
        id: nextIdRef.current++,
        title: input.title,
        description: input.description ?? null,
        tone,
        durationMs: duration,
      });
      setToasts((prev: ReadonlyArray<ToastRecord>): ReadonlyArray<ToastRecord> => {
        const next: Array<ToastRecord> = [...prev, record];
        // Cap the stack: drop oldest beyond MAX_VISIBLE and clean their timers.
        while (next.length > MAX_VISIBLE) {
          const dropped: ToastRecord | undefined = next.shift();
          if (dropped !== undefined) clearTimer(dropped.id);
        }
        return next;
      });
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => dismiss(record.id), duration);
      timersRef.current.set(record.id, timer);
    },
    [clearTimer, dismiss],
  );

  // Clear every pending timer on unmount.
  useEffect(
    () => (): void => {
      timersRef.current.forEach((timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer));
      timersRef.current.clear();
    },
    [],
  );

  const api: ToastApi = useMemo<ToastApi>(() => Object.freeze({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Viewport + item                                                     */
/* ------------------------------------------------------------------ */

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-emerald-400/40 bg-emerald-500/10 text-emerald-100",
  error: "border-rose-400/40 bg-rose-500/10 text-rose-100",
  info: "border-indigoGlow/40 bg-indigo-500/10 text-indigo-100",
};

const TONE_ICONS: Record<ToastTone, string> = {
  success: "✅",
  error: "⚠️",
  info: "💡",
};

interface ToastItemProps {
  readonly toast: ToastRecord;
  readonly onDismiss: (id: number) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`toast-enter pointer-events-auto flex w-full items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg shadow-black/40 backdrop-blur-xl ${TONE_STYLES[toast.tone]}`}
    >
      <span aria-hidden="true" className="mt-0.5 text-base leading-none">
        {TONE_ICONS[toast.tone]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{toast.title}</p>
        {toast.description !== null ? (
          <p className="mt-0.5 break-words text-xs opacity-80">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-1 rounded-full p-1 text-current opacity-60 transition hover:bg-white/10 hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
    </div>
  );
}

interface ToastViewportProps {
  readonly toasts: ReadonlyArray<ToastRecord>;
  readonly onDismiss: (id: number) => void;
}

function ToastViewport({ toasts, onDismiss }: ToastViewportProps): ReactElement {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[80] flex flex-col-reverse gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-96"
    >
      {toasts.map((toast: ToastRecord): ReactElement => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
