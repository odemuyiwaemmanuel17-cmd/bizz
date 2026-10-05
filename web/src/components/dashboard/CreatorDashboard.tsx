/** Creator dashboard: stats cards + lists of the user's bizzes & concepts. */
import { useCreatorDashboard } from "../../hooks/useCreatorDashboard";
import { formatPrice, type FeedCategory } from "../../lib/feed";
import { isValidated } from "../../lib/ideas";
import type { DashboardIdea, DashboardListing } from "../../lib/dashboard";

const CATEGORY_LABELS: Readonly<Partial<Record<FeedCategory, string>>> = Object.freeze({
  services: "Services",
  tech: "Tech",
  campus: "Campus",
  digital: "Digital",
});

interface StatCardProps {
  readonly label: string;
  readonly value: number;
  readonly accent: string; // tailwind text color class
}

function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur transition-transform hover:-translate-y-0.5">
      <p className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wider text-slate-400">{label}</p>
    </div>
  );
}

function relativeDate(iso: string): string {
  const then: number = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffDays: number = Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  return `${diffDays}d ago`;
}

function ListingRow({ listing }: { readonly listing: DashboardListing }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{listing.title}</p>
        <p className="mt-0.5 text-xs text-slate-400">
          {CATEGORY_LABELS[listing.category] ?? "Digital"} · {formatPrice(listing.priceCents)} · posted {relativeDate(listing.createdAt)}
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
        🐝 {listing.votesCount} vote{listing.votesCount === 1 ? "" : "s"}
      </span>
    </li>
  );
}

function IdeaRow({ idea }: { readonly idea: DashboardIdea }) {
  const validated: boolean = idea.status === "validated" || isValidated(idea.tally);
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-sm font-semibold text-white">{idea.title}</p>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
            validated ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"
          }`}
        >
          {validated ? "✅ Validated" : "⏳ Gathering votes"}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-yellow-400 to-lime-400 transition-all duration-500"
          style={{ width: `${idea.tally.bizzPercent}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-slate-400">
        🐝 Bizz {idea.tally.bizzPercent}% · 🫧 Fizz {idea.tally.fizzPercent}% · {idea.tally.total} vote
        {idea.tally.total === 1 ? "" : "s"} · {relativeDate(idea.createdAt)}
      </p>
    </li>
  );
}

export function CreatorDashboard() {
  const dash = useCreatorDashboard();

  if (!dash.isAuthenticated) {
    return (
      <section id="dashboard" className="mx-auto w-full max-w-5xl px-4 py-14">
        <h2 className="text-2xl font-bold text-white">Your creator dashboard</h2>
        <p className="mt-3 max-w-md text-sm text-slate-400">
          Sign in with your email above to see everything you&apos;ve posted — bizzes, concepts, votes and validation
          progress — all in one place.
        </p>
      </section>
    );
  }

  const nothingYet: boolean = !dash.loading && dash.listings.length === 0 && dash.ideas.length === 0;

  return (
    <section id="dashboard" className="mx-auto w-full max-w-5xl px-4 py-14">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">Your creator dashboard</h2>
          <p className="mt-1 text-sm text-slate-400">Track your bizzes, concepts and community support.</p>
        </div>
        <button
          type="button"
          onClick={() => void dash.refresh()}
          className="btn-glass rounded-full px-4 py-2 text-sm font-medium text-white transition hover:brightness-125 active:scale-95"
          aria-label="Refresh dashboard"
        >
          {dash.loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {dash.error !== null && (
        <p className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {dash.error}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Bizzes posted" value={dash.stats.listingsPosted} accent="text-cyan-300" />
        <StatCard label="Concepts posted" value={dash.stats.conceptsPosted} accent="text-violet-300" />
        <StatCard label="Validated ideas" value={dash.stats.validatedIdeas} accent="text-emerald-300" />
        <StatCard label="Votes received" value={dash.stats.totalVotesReceived} accent="text-amber-300" />
      </div>

      {nothingYet && (
        <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/5 p-8 text-center">
          <p className="text-lg font-semibold text-white">No posts yet 🚀</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-slate-400">
            Click <span className="font-semibold text-white">+ Post a Bizz</span> in the navbar to publish your first
            hustle or test a concept with the community.
          </p>
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        {dash.listings.length > 0 && (
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
              📌 Your bizzes ({dash.listings.length})
            </h3>
            <ul className="space-y-2">
              {dash.listings.map((listing: DashboardListing) => (
                <ListingRow key={listing.id} listing={listing} />
              ))}
            </ul>
          </div>
        )}
        {dash.ideas.length > 0 && (
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
              💡 Your concepts ({dash.ideas.length})
            </h3>
            <ul className="space-y-2">
              {dash.ideas.map((idea: DashboardIdea) => (
                <IdeaRow key={idea.id} idea={idea} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
