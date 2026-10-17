import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { fetchPublicVideos, type PublicVideo } from "../lib/videoFeed";

function VideoCard({ video }: { readonly video: PublicVideo }): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const player = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const observer = new IntersectionObserver(([entry]) => { if (!entry?.isIntersecting) player.current?.pause(); }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const profileHref = video.username === null ? "/discover" : `/@${video.username}`;
  return <article ref={container} className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-xl shadow-black/20">
    <div className="relative bg-black"><video ref={player} src={video.videoUrl} controls playsInline preload="metadata" className="aspect-[9/14] max-h-[70vh] w-full object-contain" onError={(event) => { event.currentTarget.poster = ""; }} /><span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-cyan-100">Published video</span></div>
    <div className="space-y-3 p-4"><Link to={profileHref} className="flex items-center gap-3 hover:text-cyan-200"><span className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-violet-500/30 text-sm font-bold text-white">{video.avatarUrl ? <img src={video.avatarUrl} alt="" className="h-full w-full object-cover" /> : video.displayName.charAt(0).toUpperCase()}</span><span className="text-sm font-semibold text-white">{video.username ? `@${video.username}` : video.displayName}</span></Link>{video.caption && <p className="text-sm leading-6 text-slate-300">{video.caption}</p>}<time className="block text-xs text-slate-500" dateTime={video.createdAt}>{new Date(video.createdAt).toLocaleDateString()}</time></div>
  </article>;
}

export default function VideosPage(): ReactElement {
  const [videos, setVideos] = useState<PublicVideo[]>([]); const [page, setPage] = useState(0); const [hasMore, setHasMore] = useState(true); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const loadingRef = useRef(false); const seen = useRef(new Set<string>()); const sentinel = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async (nextPage: number): Promise<void> => { if (loadingRef.current || (!hasMore && nextPage > 0)) return; loadingRef.current = true; setLoading(true); const result = await fetchPublicVideos(nextPage); setError(result.error); setVideos((current) => { const next = [...current]; for (const item of result.items) if (!seen.current.has(item.id)) { seen.current.add(item.id); next.push(item); } return next; }); setHasMore(result.hasMore); setPage(nextPage); loadingRef.current = false; setLoading(false); }, [hasMore]);
  useEffect(() => { void load(0); }, [load]);
  useEffect(() => { const element = sentinel.current; if (element === null) return; const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) void load(page + 1); }, { rootMargin: "500px" }); observer.observe(element); return () => observer.disconnect(); }, [load, page]);
  return <main className="mx-auto min-h-screen max-w-6xl px-4 pb-20 pt-32 sm:px-6"><div className="mx-auto max-w-2xl"><div className="mb-8"><p className="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-300">Watch</p><h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">Discover what creators are building</h1><p className="mt-3 text-sm leading-6 text-slate-400">Watch published videos from HustleHub creators, then visit their profile to explore their bizzes and ideas.</p></div>{error !== null && <div role="alert" className="mb-5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}{!loading && videos.length === 0 && error === null && <div className="rounded-3xl border border-dashed border-white/15 p-10 text-center text-slate-400">No published videos yet. Check back after creators share their next hustle.</div>}<div className="space-y-6">{videos.map((video) => <VideoCard key={video.id} video={video} />)}</div><div ref={sentinel} className="flex min-h-20 items-center justify-center text-sm text-slate-500">{loading ? "Loading more videos…" : !hasMore && videos.length > 0 ? "You’re all caught up." : ""}</div></div></main>;
}
