/** Creator dashboard: compact identity header, grouped navigation, and creator activity. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useCreatorDashboard } from "../../hooks/useCreatorDashboard";
import { CreatorHeader } from "./CreatorHeader";
import DashboardSidebar from "./DashboardSidebar";
import { formatPrice, type FeedCategory } from "../../lib/feed";
import { isValidated } from "../../lib/ideas";
import type { DashboardIdea, DashboardListing } from "../../lib/dashboard";
import { isCurrentVerificationAdmin } from "../../lib/verification";

const CATEGORY_LABELS: Readonly<Partial<Record<FeedCategory, string>>> = Object.freeze({
  services: "Services",
  tech: "Tech",
  campus: "Campus",
  digital: "Digital",
});

interface StatCardProps {
  readonly label: string;
  readonly value: number;
  readonly accent: string;
  readonly icon: string;
}

function StatCard({ label, value, accent, icon }: StatCardProps) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
    <div className="flex items-center justify-between gap-3"><span className={`text-lg ${accent}`} aria-hidden="true">{icon}</span><span className={`text-2xl font-black tabular-nums ${accent}`}>{value}</span></div>
    <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
  </div>;
}

function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffDays = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  return `${diffDays}d ago`;
}

function ListingRow({ listing }: { readonly listing: DashboardListing }) {
  return <li className="flex min-w-0 items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3.5 transition hover:border-violetGlow/30 hover:bg-white/[0.06]">
    <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{listing.title}</p><p className="mt-1 truncate text-xs text-slate-500">{CATEGORY_LABELS[listing.category] ?? "Digital"} · {formatPrice(listing.priceCents, listing.currency, listing.isFree)} · {relativeDate(listing.createdAt)}</p></div>
    <span className="shrink-0 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">{listing.votesCount} vote{listing.votesCount === 1 ? "" : "s"}</span>
  </li>;
}

function IdeaRow({ idea }: { readonly idea: DashboardIdea }) {
  const validated = idea.status === "validated" || isValidated(idea.tally);
  return <li className="rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3.5"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-semibold text-white">{idea.title}</p><span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${validated ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{validated ? "Validated" : "Gathering votes"}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-yellow-400 to-lime-400" style={{ width: `${idea.tally.bizzPercent}%` }} /></div><p className="mt-2 text-xs text-slate-500">Bizz {idea.tally.bizzPercent}% · Fizz {idea.tally.fizzPercent}% · {idea.tally.total} vote{idea.tally.total === 1 ? "" : "s"} · {relativeDate(idea.createdAt)}</p></li>;
}

type DashTab = "bizzes" | "concepts";

export function CreatorDashboard() {
  const dash = useCreatorDashboard();
  const [tab, setTab] = useState<DashTab>("bizzes");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!dash.isAuthenticated) { setIsAdmin(false); return; }
    let active = true;
    void isCurrentVerificationAdmin().then((allowed) => { if (active) setIsAdmin(allowed); }).catch(() => { if (active) setIsAdmin(false); });
    return () => { active = false; };
  }, [dash.isAuthenticated]);

  if (!dash.isAuthenticated) return <section id="dashboard" className="mx-auto w-full max-w-6xl px-4 py-14"><h2 className="text-2xl font-bold text-white">Your creator dashboard</h2><p className="mt-3 max-w-md text-sm text-slate-400">Sign in to see everything you&apos;ve posted — bizzes, concepts, votes and validation progress.</p></section>;

  const nothingYet = !dash.loading && dash.listings.length === 0 && dash.ideas.length === 0;
  return <section id="dashboard" className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
    {dash.user !== null && <CreatorHeader user={dash.user} />}
    <div className="mt-8 grid items-start gap-8 md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[210px_minmax(0,1fr)]">
      <DashboardSidebar isAdmin={isAdmin} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-medium text-cyan-200">Creator workspace</p><h1 className="mt-1 text-3xl font-black tracking-tight text-white">Welcome back{dash.user?.email ? ", creator" : ""}</h1><p className="mt-2 max-w-xl text-sm text-slate-400">A focused view of your bizzes, ideas, and community momentum.</p></div><button type="button" onClick={() => void dash.refresh()} className="btn-glass rounded-xl px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-125" aria-label="Refresh dashboard">{dash.loading ? "Refreshing…" : "↻ Refresh"}</button></div>
        {dash.error !== null && <p className="mt-5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{dash.error}</p>}
        <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard label="Bizzes posted" value={dash.stats.listingsPosted} accent="text-cyan-300" icon="✦" /><StatCard label="Concepts posted" value={dash.stats.conceptsPosted} accent="text-violet-300" icon="◇" /><StatCard label="Validated ideas" value={dash.stats.validatedIdeas} accent="text-emerald-300" icon="✓" /><StatCard label="Votes received" value={dash.stats.totalVotesReceived} accent="text-amber-300" icon="◌" /></div>
        {nothingYet && <div className="mt-7 rounded-2xl border border-dashed border-white/15 bg-white/[0.035] p-8 text-center"><p className="text-lg font-semibold text-white">Your workspace is ready</p><p className="mx-auto mt-2 max-w-sm text-sm text-slate-400">Post a Bizz from the top navigation or upload a creator video to get started.</p></div>}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-white">Recent activity</h2><p className="mt-1 text-xs text-slate-500">Your latest work and validation progress.</p></div><div role="tablist" aria-label="Recent activity type" className="flex rounded-xl border border-white/10 bg-white/[0.035] p-1"><button type="button" role="tab" aria-selected={tab === "bizzes"} onClick={() => setTab("bizzes")} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === "bizzes" ? "bg-violetGlow/30 text-white" : "text-slate-500 hover:text-white"}`}>Bizzes <span className="ml-1 opacity-70">{dash.listings.length}</span></button><button type="button" role="tab" aria-selected={tab === "concepts"} onClick={() => setTab("concepts")} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === "concepts" ? "bg-violetGlow/30 text-white" : "text-slate-500 hover:text-white"}`}>Concepts <span className="ml-1 opacity-70">{dash.ideas.length}</span></button></div></div>
          <div className="mt-5">{tab === "bizzes" && (dash.listings.length > 0 ? <ul className="space-y-2.5">{dash.listings.map((listing) => <ListingRow key={listing.id} listing={listing} />)}</ul> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">No active bizzes yet. Post one from the top navigation.</p>)}{tab === "concepts" && (dash.ideas.length > 0 ? <ul className="space-y-2.5">{dash.ideas.map((idea) => <IdeaRow key={idea.id} idea={idea} />)}</ul> : <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">No validation concepts yet.</p>)}</div>
        </section>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500"><Link to="/discover" className="hover:text-white">Explore Discover</Link><Link to="/validation" className="hover:text-white">Validate an idea</Link>{isAdmin && <span className="text-cyan-300/80">Administrator tools available in the sidebar</span>}</div>
      </div>
    </div>
  </section>;
}
