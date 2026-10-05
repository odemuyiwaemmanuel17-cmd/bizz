/** `/dashboard` — private control center: the signed-in user's own data only. */
import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CreatorDashboard } from "../components/dashboard/CreatorDashboard";
import { useAuth } from "../hooks/useAuth";

export default function DashboardPage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status, signOut } = useAuth();
  const [checking, setChecking] = useState<boolean>(true);

  // Auth guard: wait for the session to resolve, then bounce guests to /auth.
  useEffect(() => {
    if (status === "config-missing") {
      setChecking(false);
      return;
    }
    if (isAuthenticated) {
      setChecking(false);
      return;
    }
    // Give onAuthStateChange a moment to settle before redirecting.
    const timer: number = window.setTimeout(() => {
      if (!isAuthenticated) navigate("/auth", { replace: true });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, status, navigate]);

  async function handleSignOut(): Promise<void> {
    await signOut(); // clears the Supabase session
    navigate("/auth", { replace: true });
  }

  if (checking && status !== "config-missing") {
    return (
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-32 text-sm text-slate-400">
        Checking your session…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-32">
        <section className="glass rounded-3xl p-8 text-center">
          <h1 className="text-xl font-bold text-white">Private area 🔒</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            Your dashboard only shows your own bizzes and concepts. Sign in to
            view it.
          </p>
          <Link to="/auth" className="btn-primary mt-5 inline-block">
            Go to sign in
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="pt-24">
      {/* Page-level header with isolated sign-out action */}
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6">
        <h1 className="text-3xl font-black tracking-tight text-white">Dashboard</h1>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-500/20 active:scale-[0.97]"
        >
          Sign out &amp; clear session
        </button>
      </div>
      <CreatorDashboard />
    </div>
  );
}
