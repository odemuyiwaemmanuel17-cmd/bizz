import { Suspense, lazy, useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePrefersReducedMotion } from "./ui/micro";

const HeroBadge = lazy(() => import("./webgl/HeroBadge"));

/** WebGL-disabled fallback so the hero still renders on old devices. */
function BadgeSkeleton(): ReactElement {
  return (
    <div className="absolute inset-0 grid place-items-center" aria-hidden="true">
      <div className="h-64 w-64 animate-glow-pulse rounded-full bg-gradient-to-br from-indigoGlow/40 via-violetGlow/30 to-cyanGlow/40 blur-3xl" />
    </div>
  );
}

/** True when the device can render a WebGL context at all. */
function detectWebGL(): boolean {
  try {
    const canvas: HTMLCanvasElement = document.createElement("canvas");
    const gl: WebGLRenderingContext | null =
      canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return gl !== null;
  } catch {
    return false;
  }
}

export default function Hero(): ReactElement {
  const navigate = useNavigate();
  const reducedMotion: boolean = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState<boolean>(() => typeof window === "undefined");
  const [webglOk, setWebglOk] = useState<boolean>(true);

  // Capability checks before spinning up the R3F canvas (old GPUs, SSR tests).
  useEffect(() => {
    let cancelled: boolean = false;
    if (!detectWebGL() && !cancelled) setWebglOk(false);
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Lazy-mount the canvas only while the hero is on screen (saves mobile GPU/battery).
  useEffect(() => {
    const el: HTMLElement | null = sectionRef.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const observer: IntersectionObserver = new IntersectionObserver(
      (entries: ReadonlyArray<IntersectionObserverEntry>): void => {
        const entry: IntersectionObserverEntry | undefined = entries[0];
        if (entry !== undefined) setInView(entry.isIntersecting);
      },
      { rootMargin: "150px" },
    );
    observer.observe(el);
    return (): void => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} id="top" className="relative flex min-h-screen items-center overflow-hidden">
      {/* Ambient gradient blobs behind the canvas */}
      <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-indigoGlow/20 blur-[120px]" />
      <div className="pointer-events-none absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-cyanGlow/15 blur-[110px]" />

      {/* Interactive 3D layer (skipped without WebGL or under reduced motion) */}
      {webglOk && !reducedMotion && inView ? (
        <Suspense fallback={<BadgeSkeleton />}>
          <HeroBadge />
        </Suspense>
      ) : (
        <BadgeSkeleton />
      )}

      {/* Copy — pointer events pass through except on interactive elements */}
      <div className="pointer-events-none relative z-10 mx-auto w-full max-w-6xl px-6 pt-28 pb-16">
        <div className="max-w-2xl">
          <span className="glass pointer-events-auto inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium text-slate-300">
            <span className="h-2 w-2 animate-glow-pulse rounded-full bg-cyanGlow" />
            Phase 2 · Interactive launch experience
          </span>

          <h1 className="mt-6 text-5xl font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            Launch, test, and discover{" "}
            <span className="text-gradient">micro-hustles in seconds.</span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400">
            HustleHub turns a spark of an idea into a validated side business before your
            coffee gets cold. Post a listing, collect real votes from the community, and see
            which micro-hustle is worth your weekend.
          </p>

          <div className="pointer-events-auto mt-9 flex flex-wrap items-center gap-4">
            <button
              onClick={() => navigate("/auth?mode=signup")}
              className="rounded-2xl bg-gradient-to-r from-indigoGlow to-violetGlow px-7 py-3.5 text-base font-semibold text-white shadow-xl shadow-indigoGlow/30 transition hover:-translate-y-0.5 hover:brightness-110"
            >
              Start a micro-hustle
            </button>
            <Link
              to="/discover"
              className="glass rounded-2xl px-7 py-3.5 text-base font-semibold text-slate-200 transition hover:bg-white/10"
            >
              Browse listings ↓
            </Link>
          </div>

          <dl className="mt-12 grid max-w-md grid-cols-3 gap-6 text-sm">
            {[
              { stat: "< 10s", label: "to publish a listing" },
              { stat: "Live", label: "community validation" },
              { stat: "$0", label: "to start testing" },
            ].map((item) => (
              <div key={item.label}>
                <dt className="text-2xl font-bold text-white">{item.stat}</dt>
                <dd className="mt-1 text-slate-500">{item.label}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-10 text-xs text-slate-600">
            Tip: move your mouse — the badge follows you. Click it to pause the spin.
          </p>
        </div>
      </div>
    </section>
  );
}
