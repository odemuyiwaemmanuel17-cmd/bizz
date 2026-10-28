import { useEffect, useState, type ReactElement } from "react";
import { useLocation } from "react-router-dom";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "./ui/Toaster";
import { getSupabase } from "../lib/supabase";
import { creatorProfilePath } from "../lib/creator";
import { isCurrentVerificationAdmin } from "../lib/verification";

interface NavbarProps {
  readonly onPostBizzClick?: () => void;
}

const LINKS: ReadonlyArray<{ label: string; to: string }> = [
  { label: "Home", to: "/" },
  { label: "Discover", to: "/discover" },
  { label: "Validation", to: "/validation" },
  { label: "Dashboard", to: "/dashboard" },
];

/** Returns true when the current pathname matches a nav link (exact for "/"). */
function isActive(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname.startsWith(to);
}

export default function Navbar({ onPostBizzClick }: NavbarProps): ReactElement {
  const { isAuthenticated, user, signOut } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const [isVerificationAdmin, setIsVerificationAdmin] = useState(false);
  const [profilePath, setProfilePath] = useState<string | null>(null);
  const toast = useToast();
  const location = useLocation();

  useEffect(() => {
    if (!isAuthenticated || user === null) {
      setIsVerificationAdmin(false);
      setProfilePath(null);
      return;
    }
    let active = true;
    void isCurrentVerificationAdmin().then((allowed) => {
      if (active) setIsVerificationAdmin(allowed);
    }).catch(() => {
      if (active) setIsVerificationAdmin(false);
    });
    const sb = getSupabase();
    if (sb !== null) {
      void sb.from("profiles").select("id,username").eq("id", user.id).maybeSingle().then((result) => {
        if (!active || result.error !== null || result.data === null) return;
        const row = result.data as { id: string; username: string | null };
        setProfilePath(creatorProfilePath(row.username, row.id));
      });
    }
    return () => {
      active = false;
    };
  }, [isAuthenticated, user]);

  // Scroll to top whenever the route changes (multi-page UX).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);

  function handleSignOut(): void {
    setAccountOpen(false);
    void signOut();
    toast.push({ title: "Signed out", description: "Your drafts stay put — see you soon 👋", tone: "info" });
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <nav className="glass mx-auto mt-4 flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl px-4 py-3 shadow-lg shadow-black/30 sm:px-5">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight sm:text-base">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigoGlow via-violetGlow to-cyanGlow text-sm font-black text-white transition-transform duration-300 hover:rotate-[24deg]">
            H
          </span>
          HustleHub
        </Link>

        <ul className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          {LINKS.map((link) => (
            <li key={link.to}>
              <Link
                className={`transition hover:text-white ${isActive(location.pathname, link.to) ? "font-semibold text-white" : ""}`}
                to={link.to}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
          {isAuthenticated ? (
            <div className="relative">
              <button type="button" onClick={() => setAccountOpen((open) => !open)} aria-expanded={accountOpen} aria-haspopup="menu" className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10">
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-gradient-to-br from-indigoGlow/60 to-violetGlow/70 text-xs font-bold text-white">{(user?.email?.charAt(0) ?? "A").toUpperCase()}</span>
                <span className="hidden max-w-[120px] truncate sm:inline">{user?.email ?? "Account"}</span>
                <span aria-hidden="true" className="text-xs text-slate-500">{accountOpen ? "▲" : "▼"}</span>
              </button>
              {accountOpen && <div role="menu" className="absolute right-0 top-12 z-50 w-52 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-2xl shadow-black/40 backdrop-blur-xl"><Link role="menuitem" onClick={() => setAccountOpen(false)} to={profilePath ?? "/dashboard/profile/edit"} className="block rounded-xl px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white">My Profile</Link><Link role="menuitem" onClick={() => setAccountOpen(false)} to="/dashboard" className="block rounded-xl px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white">Dashboard</Link><Link role="menuitem" onClick={() => setAccountOpen(false)} to="/dashboard/settings" className="block rounded-xl px-3 py-2 text-sm text-slate-300 hover:bg-white/10 hover:text-white">Settings</Link>{isVerificationAdmin && <Link role="menuitem" onClick={() => setAccountOpen(false)} to="/admin" className="block rounded-xl px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-300/10">Admin</Link>}<button role="menuitem" type="button" onClick={handleSignOut} className="mt-1 w-full rounded-xl border-t border-white/10 px-3 py-2 text-left text-sm text-slate-400 hover:bg-white/10 hover:text-white">Sign out</button></div>}
            </div>
          ) : (
            <Link
              to="/auth"
              className="hidden rounded-xl bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigoGlow/25 transition hover:brightness-110 active:scale-[0.97] sm:block"
            >
              Sign in
            </Link>
          )}
          {onPostBizzClick !== undefined && (
            <button
              onClick={onPostBizzClick}
              className="rounded-xl bg-gradient-to-r from-cyanGlow/80 to-violetGlow/80 px-3 py-2 text-sm font-bold text-white shadow-lg shadow-cyanGlow/20 transition hover:brightness-110 hover:shadow-cyanGlow/40 active:scale-[0.97] sm:px-4"
            >
              + Post a Bizz
            </button>
          )}
        </div>

        {/* Mobile row: nav links stay reachable on phones */}
        <ul className="flex w-full items-center justify-around gap-2 text-sm text-slate-300 md:hidden">
          {LINKS.map((link) => (
            <li key={link.to}>
              <Link
                className={`transition hover:text-white ${isActive(location.pathname, link.to) ? "font-semibold text-white" : ""}`}
                to={link.to}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
