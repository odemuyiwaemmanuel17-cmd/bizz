import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { getSupabase } from "../lib/supabase";

interface MyVideo {
  readonly id: string;
  readonly video_url: string | null;
  readonly caption: string | null;
  readonly status: string;
  readonly created_at: string;
}

export default function MyVideosPage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status, user } = useAuth();
  const [videos, setVideos] = useState<ReadonlyArray<MyVideo>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      const pageSize = 1000;
      const allRows: MyVideo[] = [];
      for (let page = 0; ; page += 1) {
        const result = await sb
          .from("creator_videos")
          .select("id,video_url,caption,status,created_at")
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
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
