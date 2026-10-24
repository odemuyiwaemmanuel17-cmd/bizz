import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { getSupabase } from "../lib/supabase";
import { updateCreatorVideoListing } from "../lib/creator";

interface MyVideo {
  readonly id: string;
  readonly video_url: string | null;
  readonly caption: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly listing_id: string | null;
}

interface OwnedListing {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export default function MyVideosPage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status, user } = useAuth();
  const [videos, setVideos] = useState<ReadonlyArray<MyVideo>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<ReadonlyArray<OwnedListing>>([]);
  const [savingVideoId, setSavingVideoId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "config-missing") {
      setLoading(false);
      return;
    }
    if (!isAuthenticated || user === null) {
      const timer = window.setTimeout(() => navigate("/auth", { replace: true }), 1200);
      return () => window.clearTimeout(timer);
    }
    const ownerId = user.id;

    let active = true;
    async function load(): Promise<void> {
      const sb = getSupabase();
      if (sb === null) {
        if (active) { setError("Supabase is not configured."); setLoading(false); }
        return;
      }
      const listingResult = await sb
        .from("listings")
        .select("id,title,status")
        .eq("user_id", ownerId)
        .order("created_at", { ascending: false });
      if (listingResult.error !== null) {
        if (active) { setError(listingResult.error.message); setLoading(false); }
        return;
      }
      setListings((listingResult.data ?? []) as OwnedListing[]);

      const pageSize = 1000;
      const allRows: MyVideo[] = [];
      for (let page = 0; ; page += 1) {
        const result = await sb
          .from("creator_videos")
          .select("id,video_url,caption,status,created_at,listing_id")
          .eq("user_id", ownerId)
          .eq("status", "published")
          .not("video_url", "is", null)
          .order("created_at", { ascending: false })
          .range(page * pageSize, (page + 1) * pageSize - 1);
        if (result.error !== null) {
          if (active) { setError(result.error.message); setLoading(false); }
          return;
        }
        const rows = (result.data ?? []) as MyVideo[];
        allRows.push(...rows);
        if (rows.length < pageSize) break;
      }
      if (!active) return;
      setVideos(allRows);
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [isAuthenticated, navigate, status, user]);

  async function changeListing(videoId: string, listingId: string | null): Promise<void> {
    if (user === null) return;
    setSavingVideoId(videoId);
    setError(null);
    const previous = videos.find((video) => video.id === videoId)?.listing_id ?? null;
    setVideos((current) => current.map((video) => video.id === videoId ? { ...video, listing_id: listingId } : video));
    try {
      await updateCreatorVideoListing(user.id, videoId, listingId);
    } catch (err) {
      setVideos((current) => current.map((video) => video.id === videoId ? { ...video, listing_id: previous } : video));
      setError(err instanceof Error ? err.message : "The Bizz association could not be updated.");
    } finally {
      setSavingVideoId(null);
    }
  }

  if (!isAuthenticated && status !== "config-missing") {
    return <main className="mx-auto max-w-xl px-4 pb-20 pt-32 text-center text-slate-400">Checking your session…</main>;
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 pb-20 pt-32 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link>
          <p className="mt-3 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Creator library</p>
          <h1 className="mt-2 text-3xl font-black text-white">My Videos</h1>
          <p className="mt-2 text-sm text-slate-400">Your published videos, ready to watch and share.</p>
        </div>
        <Link to="/dashboard/video/upload" className="btn-primary">Upload video</Link>
      </div>
      {loading && <p className="mt-8 text-sm text-slate-400">Loading your published videos…</p>}
      {error !== null && <p role="alert" className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</p>}
      {!loading && error === null && videos.length === 0 && (
        <section className="mt-8 rounded-3xl border border-dashed border-white/15 p-10 text-center">
          <h2 className="text-xl font-bold text-white">No published videos yet</h2>
          <p className="mt-2 text-sm text-slate-400">Upload and publish your first creator video to see it here.</p>
          <Link to="/dashboard/video/upload" className="btn-primary mt-5 inline-block">Upload video</Link>
        </section>
      )}
      {!loading && error === null && videos.length > 0 && (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((video) => (
            <article key={video.id} className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
              {video.video_url !== null && <video controls playsInline preload="metadata" src={video.video_url} className="aspect-video w-full bg-black object-contain" />}
              <div className="p-4">
                <p className="text-xs text-slate-500">Published {new Date(video.created_at).toLocaleDateString()}</p>
                {video.caption !== null && <p className="mt-2 text-sm leading-6 text-slate-300">{video.caption}</p>}
                <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Linked Bizz
                  <select
                    value={video.listing_id ?? ""}
                    onChange={(event) => void changeListing(video.id, event.target.value || null)}
                    disabled={savingVideoId === video.id}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white disabled:opacity-60"
                  >
                    <option value="">No linked Bizz</option>
                    {video.listing_id !== null && !listings.some((listing) => listing.id === video.listing_id) && <option value={video.listing_id}>Linked Bizz unavailable</option>}
                    {listings.filter((listing) => listing.status === "active" || listing.id === video.listing_id).map((listing) => <option key={listing.id} value={listing.id}>{listing.title}{listing.status !== "active" ? " (unavailable)" : ""}</option>)}
                  </select>
                </label>
                {video.listing_id !== null && listings.some((listing) => listing.id === video.listing_id && listing.status === "active") && <Link to={`/listing/${video.listing_id}`} className="mt-3 inline-block text-sm font-semibold text-cyan-200 hover:text-white">View Bizz →</Link>}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
