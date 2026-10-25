/** `/discover` — the primary destination for videos, Bizzes, and creators. */
import { useEffect, useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import HustleFeed from "../components/feed/HustleFeed";
import VideosPage from "./VideosPage";
import { Link } from "react-router-dom";
import { getSupabase } from "../lib/supabase";
import { creatorProfilePath } from "../lib/creator";
import { fetchFollowingCreatorIds } from "../lib/social";
import { useAuth } from "../hooks/useAuth";
import MarketplaceSearchPanel from "../components/discover/MarketplaceSearchPanel";

interface CreatorResult {
  readonly id: string;
  readonly username: string;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly bio: string | null;
  readonly country: string | null;
  readonly creator_type: string | null;
}

function CreatorDiscovery(): ReactElement {
  const [creators, setCreators] = useState<ReadonlyArray<CreatorResult>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      const sb = getSupabase();
      if (sb === null) {
        if (active) { setLoading(false); setError("Creator discovery is unavailable while Supabase is not configured."); }
        return;
      }
      const result = await sb
        .from("profiles")
        .select("id,username,display_name,avatar_url,bio,country,creator_type")
        .not("username", "is", null)
        .order("created_at", { ascending: false })
        .range(0, 99);
      if (!active) return;
      if (result.error !== null) setError(result.error.message);
      else setCreators((result.data ?? []) as CreatorResult[]);
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, []);

  if (loading) return <section className="glass rounded-3xl p-8 text-center text-sm text-slate-400">Loading creators…</section>;
  if (error !== null) return <section role="alert" className="rounded-3xl border border-rose-400/30 bg-rose-500/10 p-8 text-center text-sm text-rose-200">{error}</section>;
  if (creators.length === 0) return <section className="glass rounded-3xl p-8 text-center"><h2 className="text-xl font-bold text-white">No creators yet</h2><p className="mt-2 text-sm text-slate-400">Creator profiles will appear here as people join HustleHub.</p></section>;

  return (
    <section aria-label="Creator discovery" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {creators.map((creator) => (
        <Link key={creator.id} to={creatorProfilePath(creator.username, creator.id)} className="rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:-translate-y-0.5 hover:border-cyan-300/30 hover:bg-white/10">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-violet-500/30 text-lg font-bold text-white">
              {creator.avatar_url ? <img src={creator.avatar_url} alt="" className="h-full w-full object-cover" /> : (creator.display_name ?? creator.username).charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-white">{creator.display_name ?? creator.username}</h2>
              <p className="truncate text-sm text-cyan-200">@{creator.username}</p>
            </div>
          </div>
          {creator.creator_type && <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-violet-200">{creator.creator_type}</p>}
          {creator.bio && <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-400">{creator.bio}</p>}
          {creator.country && <p className="mt-4 text-xs text-slate-500">{creator.country}</p>}
        </Link>
      ))}
    </section>
  );
}

export default function DiscoverPage(): ReactElement {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"videos" | "bizzes" | "creators" | "following">(searchParams.get("mode") === "bizzes" ? "bizzes" : searchParams.get("mode") === "creators" ? "creators" : searchParams.get("mode") === "following" ? "following" : "videos");
  const { isAuthenticated } = useAuth();
  const [followingIds, setFollowingIds] = useState<string[] | null>(null);
  useEffect(() => { if (mode !== "following" || !isAuthenticated) { setFollowingIds(null); return; } let active = true; void fetchFollowingCreatorIds().then((ids) => { if (active) setFollowingIds(ids); }).catch(() => { if (active) setFollowingIds([]); }); return () => { active = false; }; }, [isAuthenticated, mode]);
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-28 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">Discover HustleHub</h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 sm:text-base">
          Watch creators, explore Bizzes, and find the people building useful businesses around you.
        </p>
      </header>
      <MarketplaceSearchPanel />
      <div role="tablist" aria-label="Discovery modes" className="mb-6 flex max-w-xl gap-2 overflow-x-auto rounded-2xl bg-white/5 p-1">
        {(["videos", "bizzes", "creators", "following"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => setMode(item)} className={`rounded-xl px-4 py-2 text-sm font-semibold capitalize ${mode === item ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>{item === "videos" ? "Videos" : item === "bizzes" ? "Bizzes" : item === "creators" ? "Creators" : "Following"}</button>)}
      </div>
      {mode === "videos" && <VideosPage />}
      {mode === "following" && (isAuthenticated ? <VideosPage creatorIds={followingIds ?? []} followingMode /> : <section className="glass rounded-3xl p-8 text-center"><h2 className="text-xl font-bold text-white">Your Following feed</h2><p className="mt-2 text-sm text-slate-400">Sign in to see videos from creators you follow.</p><Link to={`/auth?next=${encodeURIComponent("/discover?mode=following")}`} className="btn-primary mt-5 inline-block">Sign in</Link></section>)}
      {mode === "bizzes" && <HustleFeed />}
       {mode === "creators" && <CreatorDiscovery />}
    </div>
  );
}
