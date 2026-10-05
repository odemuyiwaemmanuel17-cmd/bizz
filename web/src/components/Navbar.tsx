import { useState, type FormEvent, type ReactElement } from "react";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "./ui/Toaster";

interface NavbarProps {
  readonly onWaitlistClick: () => void;
  readonly onPostBizzClick?: () => void;
}

const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Discover", href: "#feed" },
  { label: "Validation", href: "#validate" },
  { label: "Dashboard", href: "#dashboard" },
];

export default function Navbar({ onWaitlistClick, onPostBizzClick }: NavbarProps): ReactElement {
  const { isAuthenticated, user, signIn, signOut } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState<string>("");
  const [sending, setSending] = useState<boolean>(false);

  async function handleSignIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const trimmed: string = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      toast.push({ title: "Enter a valid email address.", tone: "error" });
      return;
    }
    setSending(true);
    const result = await signIn(trimmed);
    setSending(false);
    if (result.ok) {
      toast.push({ title: `Magic link sent to ${trimmed}`, description: "Check your inbox — the token expires in minutes.", tone: "success" });
      setEmail("");
    } else {
      toast.push({ title: "Sign-in failed", description: result.message, tone: "error" });
    }
  }

  function handleSignOut(): void {
    void signOut();
    toast.push({ title: "Signed out", description: "Your drafts stay put — see you soon 👋", tone: "info" });
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <nav className="glass mx-auto mt-4 flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl px-4 py-3 shadow-lg shadow-black/30 sm:px-5">
        <a href="#top" className="flex items-center gap-2 text-sm font-semibold tracking-tight sm:text-base">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigoGlow via-violetGlow to-cyanGlow text-sm font-black text-white transition-transform duration-300 hover:rotate-[24deg]">
            H
          </span>
          HustleHub
        </a>

        <ul className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a className="transition hover:text-white" href={link.href}>
                {link.label}
              </a>
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
            <form onSubmit={(e) => void handleSignIn(e)} className="hidden items-center gap-2 sm:flex">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@sideproject.dev"
                aria-label="Email for magic sign-in link"
                className="w-40 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition focus:border-indigoGlow lg:w-52"
              />
              <button
                type="submit"
                disabled={sending}
                className="rounded-xl bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigoGlow/25 transition hover:brightness-110 active:scale-[0.97] disabled:cursor-wait disabled:opacity-60"
              >
                {sending ? "Sending…" : "Sign in"}
              </button>
            </form>
          )}
          {onPostBizzClick !== undefined && (
            <button
              onClick={onPostBizzClick}
              className="rounded-xl bg-gradient-to-r from-cyanGlow/80 to-violetGlow/80 px-3 py-2 text-sm font-bold text-white shadow-lg shadow-cyanGlow/20 transition hover:brightness-110 hover:shadow-cyanGlow/40 active:scale-[0.97] sm:px-4"
            >
              + Post a Bizz
            </button>
          )}
          <button
            onClick={onWaitlistClick}
            className="hidden rounded-xl border border-cyanGlow/40 px-4 py-2 text-sm font-semibold text-cyanGlow transition hover:bg-cyanGlow/10 lg:block"
          >
            Join waitlist
          </button>
        </div>

        {/* Mobile row: compact magic-link sign-in stays reachable on phones */}
        {!isAuthenticated && (
          <form onSubmit={(e) => void handleSignIn(e)} className="flex w-full items-center gap-2 sm:hidden">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@sideproject.dev"
              aria-label="Email for magic sign-in link"
              inputMode="email"
              autoComplete="email"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition focus:border-indigoGlow"
            />
            <button
              type="submit"
              disabled={sending}
              className="shrink-0 rounded-xl bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigoGlow/25 transition hover:brightness-110 active:scale-[0.97] disabled:cursor-wait disabled:opacity-60"
            >
              {sending ? "Sending…" : "Sign in"}
            </button>
          </form>
        )}
      </nav>
    </header>
  );
}
