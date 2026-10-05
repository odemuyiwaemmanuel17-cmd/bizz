import { useEffect, type ReactElement } from "react";
import { useLocation } from "react-router-dom";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "./ui/Toaster";

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
  const toast = useToast();
  const location = useLocation();

  // Scroll to top whenever the route changes (multi-page UX).
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);

  function handleSignOut(): void {
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
            <>
              <span className="hidden max-w-[180px] truncate text-sm text-slate-300 sm:inline">
                {user?.email ?? "Signed in"}
              </span>
              <button
                onClick={handleSignOut}
                className="rounded-xl border border-white/15 px-3 py-2 text-sm transition hover:bg-white/10 active:scale-[0.97] sm:px-4"
              >
                Sign out
              </button>
            </>
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
