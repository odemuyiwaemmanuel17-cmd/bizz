import { useCallback, useEffect, useState, type ReactElement } from "react";

interface AnimatedNumberProps {
  readonly value: number;
  readonly durationMs?: number;
  readonly className?: string;
  readonly format?: (value: number) => string;
}

/**
 * Micro-interaction: tweens between numeric values (used for live Bizz/Fizz
 * tallies). Respects prefers-reduced-motion by snapping instantly. Falls back
 * to plain rendering when requestAnimationFrame is unavailable (SSR/tests).
 */
export default function AnimatedNumber({
  value,
  durationMs = 650,
  className,
  format,
}: AnimatedNumberProps): ReactElement {
  const [display, setDisplay] = useState<number>(value);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduceMotion: boolean =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || typeof window.requestAnimationFrame !== "function" || display === value) {
      setDisplay(value);
      return;
    }
    const from: number = display;
    const to: number = value;
    const start: number = performance.now();
    let frame: number = window.requestAnimationFrame(function tick(now: number): void {
      const t: number = Math.min(1, (now - start) / Math.max(1, durationMs));
      const eased: number = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const next: number = Math.round(from + (to - from) * eased);
      setDisplay(next);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    });
    return (): void => window.cancelAnimationFrame(frame);
    // `display` intentionally omitted: it is the tween's starting snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs]);

  const text: string = format !== undefined ? format(display) : String(display);
  return <span className={className}>{text}</span>;
}

/** Hook mirroring the CSS media query so JS-driven effects can opt out too. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query: MediaQueryList = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return (): void => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface PulseApi {
  readonly pulse: () => void;
  readonly pulsing: boolean;
}

/** Short-lived "bump" state used to animate vote buttons on success. */
export function usePulse(durationMs = 450): PulseApi {
  const [pulsing, setPulsing] = useState<boolean>(false);
  useEffect(() => {
    if (!pulsing) return;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => setPulsing(false), durationMs);
    return (): void => clearTimeout(timer);
  }, [pulsing, durationMs]);
  const pulse = useCallback((): void => setPulsing(true), []);
  return { pulse, pulsing };
}
