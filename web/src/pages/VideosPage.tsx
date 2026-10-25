import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { fetchPublicVideos, type PublicVideo } from "../lib/videoFeed";
import { addVideoComment, deleteVideoComment, fetchVideoSocial, reportVideoComment, toggleSavedVideo, toggleVideoLike, updateVideoComment, type SocialComment, type VideoSocialState } from "../lib/social";
import { useAuth } from "../hooks/useAuth";
import { creatorProfilePath } from "../lib/creator";
import { trackAnalyticsEvent } from "../lib/analytics";

function formatCommentDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function CommentRow({ comment, currentUserId, onRefresh, onError }: { readonly comment: SocialComment; readonly currentUserId: string | null; readonly onRefresh: () => Promise<void>; readonly onError: (message: string) => void }): ReactElement {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const own = currentUserId === comment.userId;
  async function edit(): Promise<void> {
    setBusy(true);
    try { await updateVideoComment(comment.id, body); setEditing(false); await onRefresh(); } catch (error) { onError(error instanceof Error ? error.message : "Comment could not be updated."); } finally { setBusy(false); }
  }
  async function remove(): Promise<void> {
    setBusy(true);
    try { await deleteVideoComment(comment.id); await onRefresh(); } catch (error) { onError(error instanceof Error ? error.message : "Comment could not be deleted."); } finally { setBusy(false); }
  }
  async function report(): Promise<void> {
    const reason = window.prompt("Why are you reporting this comment?");
    if (reason === null) return;
    setBusy(true);
    try { await reportVideoComment(comment.id, reason); onError("Comment report submitted."); } catch (error) { onError(error instanceof Error ? error.message : "Comment could not be reported."); } finally { setBusy(false); }
  }
  return <li className="rounded-2xl border border-white/10 bg-white/5 p-3"><div className="flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-500/30 text-xs font-bold text-white">{(comment.username ?? "C").charAt(0).toUpperCase()}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-xs"><Link to={creatorProfilePath(comment.username, comment.userId)} className="font-semibold text-cyan-200 hover:text-white">{comment.username ? `@${comment.username}` : "Creator"}</Link><time className="text-slate-500" dateTime={comment.createdAt}>{formatCommentDate(comment.createdAt)}</time>{comment.updatedAt !== comment.createdAt && <span className="text-slate-500">edited</span>}</div>{editing ? <div className="mt-2 flex gap-2"><input value={body} maxLength={500} onChange={(event) => setBody(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button type="button" disabled={busy} onClick={() => void edit()} className="btn-primary px-3 py-2 text-xs">Save</button><button type="button" disabled={busy} onClick={() => setEditing(false)} className="btn-glass px-3 py-2 text-xs">Cancel</button></div> : <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{comment.body}</p>}<div className="mt-2 flex gap-3 text-xs text-slate-500">{own && !editing && <><button type="button" disabled={busy} onClick={() => setEditing(true)} className="hover:text-white">Edit</button><button type="button" disabled={busy} onClick={() => void remove()} className="hover:text-rose-200">Delete</button></>}{!own && <button type="button" disabled={busy} onClick={() => void report()} className="hover:text-rose-200">Report</button>}</div></div></div></li>;
}

function VideoCard({ video }: { readonly video: PublicVideo }): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const player = useRef<HTMLVideoElement | null>(null);
  const viewTracked = useRef(false);
  const { isAuthenticated, user } = useAuth();
  const [social, setSocial] = useState<VideoSocialState>({ likes: 0, liked: false, saved: false, comments: [], commentCount: 0 });
  const [comment, setComment] = useState("");
  const [showComments, setShowComments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const refreshSocial = useCallback(async (): Promise<void> => setSocial(await fetchVideoSocial(video.id)), [video.id]);
  useEffect(() => { const element = container.current; if (element === null || typeof IntersectionObserver === "undefined") return; const observer = new IntersectionObserver(([entry]) => { if (!entry?.isIntersecting) player.current?.pause(); else if (!viewTracked.current) { viewTracked.current = true; void trackAnalyticsEvent({ event: "video_view", videoId: video.id, dedupeId: video.id }); } }, { threshold: 0.5 }); observer.observe(element); return () => observer.disconnect(); }, [video.id]);
  useEffect(() => { let active = true; void fetchVideoSocial(video.id).then((next) => { if (active) setSocial(next); }).catch((error: unknown) => { if (active) setSocialError(error instanceof Error ? error.message : "Social activity could not be loaded."); }); return () => { active = false; }; }, [video.id]);
  async function like(): Promise<void> { if (!isAuthenticated) { setSocialError("Sign in to like videos."); return; } const previous = social; setSocial({ ...social, liked: !social.liked, likes: social.likes + (social.liked ? -1 : 1) }); try { await toggleVideoLike(video.id, previous.liked); if (!previous.liked) void trackAnalyticsEvent({ event: "video_like", videoId: video.id }); } catch (error) { setSocial(previous); setSocialError(error instanceof Error ? error.message : "Like could not be saved."); } }
  async function save(): Promise<void> { if (!isAuthenticated) { setSocialError("Sign in to save videos."); return; } const previous = social; setSocial({ ...social, saved: !social.saved }); try { await toggleSavedVideo(video.id, previous.saved); if (!previous.saved) void trackAnalyticsEvent({ event: "video_save", videoId: video.id }); } catch (error) { setSocial(previous); setSocialError(error instanceof Error ? error.message : "Save could not be updated."); } }
  async function submitComment(event: FormEvent): Promise<void> { event.preventDefault(); if (!isAuthenticated) { setSocialError("Sign in to comment."); return; } setBusy(true); setSocialError(null); try { await addVideoComment(video.id, comment); setComment(""); await refreshSocial(); setShowComments(true); } catch (error) { setSocialError(error instanceof Error ? error.message : "Comment could not be saved."); } finally { setBusy(false); } }
  const profileHref = creatorProfilePath(video.username, video.creatorId);
  return <article ref={container} className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-xl shadow-black/20"><div className="relative bg-black"><video ref={player} src={video.videoUrl} controls playsInline preload="metadata" className="aspect-[9/14] max-h-[70vh] w-full object-contain" /><span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-cyan-100">Published video</span></div><div className="space-y-3 p-4"><Link to={profileHref} className="flex items-center gap-3 hover:text-cyan-200"><span className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-violet-500/30 text-sm font-bold text-white">{video.avatarUrl ? <img src={video.avatarUrl} alt="" className="h-full w-full object-cover" /> : video.displayName.charAt(0).toUpperCase()}</span><span className="text-sm font-semibold text-white">{video.username ? `@${video.username}` : video.displayName}</span></Link>{video.caption && <p className="text-sm leading-6 text-slate-300">{video.caption}</p>}<div className="flex flex-wrap gap-2"><button type="button" onClick={() => void like()} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${social.liked ? "bg-rose-500/20 text-rose-200" : "bg-white/10 text-slate-300"}`}>{social.liked ? "♥" : "♡"} {social.likes}</button><button type="button" onClick={() => setShowComments(!showComments)} className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300">💬 {social.commentCount}</button><button type="button" onClick={() => void save()} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${social.saved ? "bg-cyan-400/20 text-cyan-100" : "bg-white/10 text-slate-300"}`}>{social.saved ? "Saved" : "Save"}</button>{video.listingId && <Link to={`/listing/${video.listingId}`} onClick={() => void trackAnalyticsEvent({ event: "video_to_bizz_click", videoId: video.id, listingId: video.listingId ?? undefined, dedupeId: `${video.id}:${video.listingId}` })} className="rounded-full bg-amber-400/15 px-3 py-1.5 text-xs font-semibold text-amber-200">View linked Bizz</Link>}</div>{socialError && <p role="alert" className="text-xs text-rose-200">{socialError}</p>}{showComments && <section aria-label="Video comments" className="space-y-3 border-t border-white/10 pt-3"><form onSubmit={(event) => void submitComment(event)} className="flex gap-2"><input value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} placeholder={isAuthenticated ? "Add a thoughtful comment…" : "Sign in to comment"} disabled={busy || !isAuthenticated} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-500" /><button type="submit" disabled={busy || !isAuthenticated || comment.trim().length === 0} className="btn-primary px-3 py-2 text-xs">{busy ? "Posting…" : "Post"}</button></form>{social.comments.length === 0 ? <p className="text-sm text-slate-500">No comments yet. Start the conversation.</p> : <ul className="space-y-2">{social.comments.map((item) => <CommentRow key={item.id} comment={item} currentUserId={user?.id ?? null} onRefresh={refreshSocial} onError={setSocialError} />)}</ul>}</section>}</div></article>;
}

export default function VideosPage({ creatorIds, followingMode = false }: { readonly creatorIds?: ReadonlyArray<string>; readonly followingMode?: boolean } = {}): ReactElement {
  const [videos, setVideos] = useState<PublicVideo[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const seen = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async (nextPage: number): Promise<void> => { if (loadingRef.current || (!hasMore && nextPage > 0)) return; loadingRef.current = true; setLoading(true); const result = await fetchPublicVideos(nextPage, creatorIds); setError(result.error); setVideos((current) => { const next = [...current]; for (const item of result.items) if (!seen.current.has(item.id)) { seen.current.add(item.id); next.push(item); } return next; }); setHasMore(result.hasMore); setPage(nextPage); loadingRef.current = false; setLoading(false); }, [creatorIds, hasMore]);
  useEffect(() => { setVideos([]); setPage(0); setHasMore(true); seen.current.clear(); void load(0); }, [creatorIds, load]);
  useEffect(() => { const element = sentinel.current; if (element === null) return; const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) void load(page + 1); }, { rootMargin: "500px" }); observer.observe(element); return () => observer.disconnect(); }, [load, page]);
  return <main className="mx-auto min-h-screen max-w-6xl px-4 pb-20 pt-8 sm:px-6"><div className="mx-auto max-w-2xl"><div className="mb-8"><p className="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-300">{followingMode ? "Following" : "Watch"}</p><h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">{followingMode ? "Videos from creators you follow" : "Discover what creators are building"}</h1><p className="mt-3 text-sm leading-6 text-slate-400">{followingMode ? "Keep up with the creators and offers you choose to follow." : "Watch published videos from HustleHub creators, then visit their profile to explore their bizzes and ideas."}</p></div>{error !== null && <div role="alert" className="mb-5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}{!loading && videos.length === 0 && error === null && <div className="rounded-3xl border border-dashed border-white/15 p-10 text-center text-slate-400">{followingMode ? "No videos from followed creators yet." : "No published videos yet."}</div>}<div className="space-y-6">{videos.map((video) => <VideoCard key={video.id} video={video} />)}</div><div ref={sentinel} className="flex min-h-20 items-center justify-center text-sm text-slate-500">{loading ? "Loading more videos…" : !hasMore && videos.length > 0 ? "You’re all caught up." : ""}</div></div></main>;
}
