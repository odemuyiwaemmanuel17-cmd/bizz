/** `/auth` — dedicated sign-in / sign-up view (email+password & Google OAuth). */
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { isSupabaseConfigured } from "../lib/supabase";
import { useToast } from "../components/ui/Toaster";

type Mode = "signin" | "signup";

const EMAIL_RE: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Inline SVG Google “G” mark (no external asset needed). */
function GoogleIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/>
    </svg>
  );
}

export default function AuthPage(): ReactElement {
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthenticated, status, signInPassword, signUp, signInGoogle } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  // Error state may hold a plain string OR an arbitrary thrown value/object
  // (e.g. a Supabase AuthError). Never render it raw in JSX — objects would
  // display as "{}". Always normalize through errorMessage().
  const [error, setError] = useState<string | Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  /** Safely extract a human-readable message from any error shape. */
  function errorMessage(value: string | Record<string, unknown> | null): string {
    if (value === null) return "Something went wrong. Please try again.";
    if (typeof value === "string") return value;
    const candidate: unknown = value["message"] ?? value["error_description"] ?? value["error"];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    return "Something went wrong. Please try again.";
  }

  // Already signed in? Straight to the dashboard.
  useEffect(() => {
    if (isAuthenticated) navigate("/dashboard", { replace: true });
  }, [isAuthenticated, navigate]);

  const configured: boolean = isSupabaseConfigured() || status === "authenticated";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    try {
      const result = mode === "signin"
        ? await signInPassword(email.trim(), password)
        : await signUp(email.trim(), password);
      if (!result.ok) {
        setError(typeof result.message === "string" && result.message.length > 0
          ? result.message
          : errorMessage(null));
        return;
      }
      if (mode === "signup") {
        toast.push({
          title: "Account created 🎉",
          description: "Check your inbox to confirm your email, then sign in.",
          tone: "success",
        });
        setMode("signin");
      } else {
        navigate("/dashboard", { replace: true });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await signInGoogle();
      if (!result.ok) {
        setError(typeof result.message === "string" && result.message.length > 0
          ? result.message
          : errorMessage(null));
      }
      // On success Supabase redirects the browser to /dashboard.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 pb-16 pt-32">
      <div className="glass rounded-3xl p-6 shadow-xl shadow-black/40 sm:p-8">
        <h1 className="text-2xl font-black tracking-tight text-white">
          {mode === "signin" ? "Welcome back" : "Join HustleHub"}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {mode === "signin"
            ? "Sign in to manage your bizzes and vote on ideas."
            : "Create an account to post gigs and test your ideas."}
        </p>

        {!configured && (
          <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            Supabase env vars are not configured in this build — auth will run in
            offline demo mode. Set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY to
            enable real accounts.
          </p>
        )}

        {/* Mode tabs */}
        <div role="tablist" aria-label="Authentication mode" className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => { setMode(m); setError(null); }}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                mode === m ? "bg-gradient-to-r from-indigoGlow to-violetGlow text-white shadow" : "text-slate-300 hover:text-white"
              }`}
            >
              {m === "signin" ? "Sign In" : "Sign Up"}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4" noValidate>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@campus.edu"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyanGlow/60 focus:bg-white/10"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Password</span>
            <input
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyanGlow/60 focus:bg-white/10"
            />
          </label>

          {error !== null && (
            <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              {typeof error === "string" ? error : errorMessage(error)}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Working…" : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-slate-500">
          <span className="h-px flex-1 bg-white/10" /> or continue with <span className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          onClick={() => void handleGoogle()}
          disabled={busy}
          className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 active:scale-[0.98] disabled:opacity-60"
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <p className="mt-5 text-center text-xs text-slate-500">
          By continuing you agree to keep it friendly.{" "}
          <Link to="/" className="text-slate-400 underline-offset-2 hover:text-white hover:underline">
            Back home
          </Link>
        </p>
      </div>
    </div>
  );
}
