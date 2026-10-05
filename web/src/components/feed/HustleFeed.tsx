import { useCallback, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import HustleCard from "./HustleCard";
import CategoryTabs from "./CategoryTabs";
import { useHustleFeed } from "../../hooks/useHustleFeed";
import type { HustleCardData } from "../../lib/feed";

function SkeletonCard(): ReactElement {
  return (
    <div className="glass h-72 animate-pulse rounded-3xl p-6">
      <div className="h-5 w-24 rounded-full bg-white/10" />
      <div className="mt-6 h-5 w-3/4 rounded bg-white/10" />
      <div className="mt-3 h-4 w-full rounded bg-white/5" />
      <div className="mt-2 h-4 w-2/3 rounded bg-white/5" />
      <div className="mt-10 h-9 w-full rounded-xl bg-white/10" />
    </div>
  );
}

/** The discovery feed: search + tabs + card grid + pagination controls. */
export default function HustleFeed(): ReactElement {
  const navigate = useNavigate();
  const feed = useHustleFeed("all");
  const [searchDraft, setSearchDraft] = useState<string>("");

  const handleSearchSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      feed.setSearch(searchDraft);
    },
    [feed, searchDraft],
  );

  return (
    <section id="feed" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Discover <span className="text-gradient">validated hustles</span>
          </h2>
          <p className="mt-2 max-w-xl text-slate-400">
            Live listings from student founders. Vote on the ones you&apos;d actually pay for —
            and message creators instantly.
          </p>
        </div>
        <p className="text-sm text-slate-500">
          {feed.loading ? "Loading…" : `${feed.total} hustle${feed.total === 1 ? "" : "s"} · page ${feed.page}/${feed.totalPages}`}
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearchSubmit} className="mt-8 flex gap-2 sm:max-w-md">
        <input
          type="search"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="Search hustles, e.g. “design”, “tutoring”…"
          aria-label="Search hustles"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm outline-none transition focus:border-indigoGlow"
        />
        <button
          type="submit"
          className="shrink-0 rounded-xl bg-gradient-to-r from-indigoGlow to-violetGlow px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigoGlow/25 transition hover:brightness-110 active:scale-[0.97]"
        >
          Search
        </button>
        {feed.search !== "" && (
          <button
            type="button"
            onClick={() => {
              setSearchDraft("");
              feed.setSearch("");
            }}
            className="shrink-0 rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-white/10"
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </form>

      <div className="mt-6">
        <CategoryTabs active={feed.category} onSelect={feed.setCategory} />
      </div>

      {feed.error !== null && (
        <p role="alert" className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {feed.error} — showing demo data instead.{" "}
          <button type="button" onClick={feed.refresh} className="underline hover:text-white">
            Retry
          </button>
        </p>
      )}

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {feed.loading
          ? Array.from({ length: 6 }, (_unused: undefined, index: number) => <SkeletonCard key={`skeleton-${index}`} />)
          : feed.items.map((card: HustleCardData) => <HustleCard key={card.id} card={card} />)}
      </div>

      {!feed.loading && feed.items.length === 0 && (
        <div className="glass mt-10 rounded-3xl p-12 text-center">
          <p className="text-lg font-semibold text-white">
            {feed.search !== "" ? `No hustles match “${feed.search}”` : "No hustles in this category yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            Be the first — launch a micro-hustle here and collect validation votes within minutes.{" "}
            <Link to="/auth?mode=signup" className="font-semibold text-cyanGlow underline-offset-2 hover:underline">
              Sign up
            </Link>{" "}
            or{" "}
            <button type="button" onClick={() => navigate("/validation")} className="font-semibold text-cyanGlow underline-offset-2 hover:underline">
              test a concept
            </button>{" "}
            now.
          </p>
        </div>
      )}

      {!feed.loading && feed.totalPages > 1 && (
        <nav aria-label="Feed pagination" className="mt-10 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={feed.previous}
            disabled={feed.page <= 1}
            className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm font-semibold text-slate-200 transition enabled:hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-sm tabular-nums text-slate-400">
            {feed.page} / {feed.totalPages}
          </span>
          <button
            type="button"
            onClick={feed.next}
            disabled={feed.page >= feed.totalPages}
            className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm font-semibold text-slate-200 transition enabled:hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next →
          </button>
        </nav>
      )}
    </section>
  );
}
