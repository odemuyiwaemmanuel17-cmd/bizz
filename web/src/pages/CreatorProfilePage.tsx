import { useEffect, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";

interface Profile { id: string; username: string; display_name: string | null; bio: string | null; avatar_url: string | null; campus: string | null; state: string | null; country: string | null; creator_type: string | null; is_verified: boolean | null; }
interface Video { id: string; video_url: string; caption: string | null; status: "published"; }
interface Item { id: string; title: string; description: string | null; }

export default function CreatorProfilePage(): ReactElement {
  const { username: raw } = useParams<{ username: string }>();
  const username = (raw ?? "").replace(/^@/, "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [listings, setListings] = useState<Item[]>([]);
  const [ideas, setIdeas] = useState<Item[]>([]);
  const [tab, setTab] = useState<"videos" | "bizzes" | "ideas">("videos");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      const sb = getSupabase();
      if (sb === null) { setError("Supabase is not configured."); setLoading(false); return; }
      try {
        const result = await sb.from("profiles").select("*").eq("username", username).maybeSingle();
        if (result.error) throw new Error(result.error.message);
        if (!result.data) { setError("Creator profile not found."); return; }
        const row = result.data as Profile;
        const [videoResult, listingResult, ideaResult] = await Promise.all([
          sb.from("creator_videos").select("id,video_url,caption,status").eq("user_id", row.id).eq("status", "published").order("created_at", { ascending: false }),
          sb.from("listings").select("id,title,description").eq("user_id", row.id).eq("status", "active").order("created_at", { ascending: false }),
          sb.from("ideas").select("id,title,description").eq("user_id", row.id).order("created_at", { ascending: false }),
        ]);
        const relatedError = videoResult.error ?? listingResult.error ?? ideaResult.error;
        if (relatedError !== null) throw new Error(relatedError.message);
        if (active) { setProfile(row); setVideos((videoResult.data as Video[] | null) ?? []); setListings((listingResult.data as Item[] | null) ?? []); setIdeas((ideaResult.data as Item[] | null) ?? []); }
      } catch (err) { if (active) setError(err instanceof Error ? err.message : "Profile could not be loaded."); }
      finally { if (active) setLoading(false); }
    }
    void load(); return () => { active = false; };
  }, [username]);

  if (loading) return <div className="pt-32 text-center text-slate-400">Loading creator profile…</div>;
  if (error !== null || profile === null) return <div className="mx-auto max-w-3xl px-4 pb-16 pt-32 text-center"><p className="text-rose-200">{error ?? "Creator profile not found."}</p><Link to="/discover" className="btn-glass mt-5 inline-block">Back to Discover</Link></div>;
  const location = profile.campus ?? [profile.state, profile.country].filter(Boolean).join(", ");
  const tabs = ["videos", "bizzes", "ideas"] as const;
  return <main className="mx-auto max-w-5xl px-4 pb-16 pt-32">
    <section className="rounded-3xl border border-white/10 bg-white/5 p-6"><div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left"><div className="h-24 w-24 overflow-hidden rounded-full border border-violetGlow/40 bg-white/10">{profile.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center text-3xl font-black text-white">{(profile.display_name ?? profile.username).charAt(0).toUpperCase()}</span>}</div><div><h1 className="text-3xl font-black text-white">{profile.display_name ?? profile.username}{profile.is_verified === true && <span className="ml-2 text-cyan-300">✓</span>}</h1><p className="text-slate-400">@{profile.username}{location && ` • ${location}`}</p>{profile.creator_type && <p className="mt-1 text-sm text-violet-200">{profile.creator_type}</p>}{profile.bio && <p className="mt-2 max-w-xl text-sm text-slate-300">{profile.bio}</p>}</div></div><div role="tablist" className="mt-6 flex gap-2 border-t border-white/10 pt-4">{tabs.map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)} className={`rounded-full px-4 py-2 text-sm font-semibold capitalize ${tab === name ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>{name}</button>)}</div></section>
    <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tab === "videos" && (videos.length === 0 ? <p className="text-sm text-slate-400">No videos published yet.</p> : videos.map((video) => <article key={video.id} className="overflow-hidden rounded-2xl border border-white/10 bg-white/5"><video controls src={video.video_url} className="aspect-video w-full bg-black" /><p className="p-3 text-sm text-slate-300">{video.caption ?? ""}</p></article>))}
      {tab === "bizzes" && (listings.length === 0 ? <p className="text-sm text-slate-400">No active bizzes yet.</p> : listings.map((item) => <article key={item.id} className="rounded-2xl border border-white/10 bg-white/5 p-4"><h2 className="font-semibold text-white">{item.title}</h2><p className="mt-2 text-sm text-slate-400">{item.description ?? ""}</p></article>))}
      {tab === "ideas" && (ideas.length === 0 ? <p className="text-sm text-slate-400">No ideas posted yet.</p> : ideas.map((item) => <article key={item.id} className="rounded-2xl border border-white/10 bg-white/5 p-4"><h2 className="font-semibold text-white">{item.title}</h2><p className="mt-2 text-sm text-slate-400">{item.description ?? ""}</p></article>))}
    </section>
  </main>;
}
