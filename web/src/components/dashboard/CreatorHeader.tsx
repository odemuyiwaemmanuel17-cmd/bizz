import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "../../lib/supabase";
import { creatorProfilePath } from "../../lib/creator";

interface ProfileRow {
  readonly id: string; readonly username: string | null; readonly display_name: string | null;
  readonly bio: string | null; readonly avatar_url: string | null; readonly creator_type: string | null;
  readonly campus: string | null; readonly state: string | null; readonly country: string | null; readonly is_verified: boolean | null;
}

export function CreatorHeader({ user }: { readonly user: User }): ReactElement {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const loadProfile = useCallback(async (): Promise<void> => {
    const sb = getSupabase();
    if (sb === null) { setLoaded(true); return; }
    try { const result = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle(); if (result.error) { console.error("[CreatorHeader] profile load failed:", result.error.message); setProfileLoadError(result.error.message); } else { setProfile((result.data as ProfileRow | null) ?? null); } } catch (error) { console.error("[CreatorHeader] profile load failed:", error); setProfileLoadError(error instanceof Error ? error.message : "Profile could not be loaded."); } finally { setLoaded(true); }
  }, [user.id]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);
  const displayName = profile?.display_name ?? String(user.user_metadata?.["full_name"] ?? user.email?.split("@")[0] ?? "Creator");
  const username = profile?.username ?? null;
  const location = profile?.campus ?? [profile?.state, profile?.country].filter(Boolean).join(", ");
  const setupPath = "/dashboard/profile/setup";
  const profileReady = loaded && profile !== null;
  const profileMissing = loaded && profile === null;
  return <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 backdrop-blur sm:p-5">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3"><div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl border border-violetGlow/40 bg-gradient-to-br from-indigoGlow/30 to-violetGlow/30">{profile?.avatar_url && loaded ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center text-xl font-black text-white/80">{displayName.charAt(0).toUpperCase()}</span>}</div><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-base font-bold text-white">{displayName}{profile?.is_verified === true && <span className="ml-1.5 text-cyan-300" title="Verified creator">✓</span>}</p></div>{username ? <p className="truncate text-xs text-slate-400">@{username}</p> : profileLoadError !== null ? <p role="alert" className="text-xs text-rose-200">Profile could not be loaded. Refresh and try again.</p> : <button type="button" onClick={() => navigate(setupPath)} className="text-xs font-medium text-amber-300 hover:underline">Set up your @username →</button>}{profile?.bio ? <p className="mt-1 line-clamp-1 max-w-xl text-xs text-slate-500">{profile.bio}</p> : location && <p className="mt-1 truncate text-xs text-slate-500">{profile?.creator_type ? `${profile.creator_type} · ` : ""}{location}</p>}</div></div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end"><button type="button" onClick={() => navigate("/dashboard/video/upload")} className="order-first rounded-xl bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigoGlow/15">+ Upload Video</button><div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1"><button type="button" onClick={() => navigate(profileReady && username ? creatorProfilePath(username, user.id) : setupPath)} disabled={!loaded} className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-60">{!loaded ? "Loading…" : profileMissing ? "Set up Profile" : username ? "View Profile" : "Set up @username"}</button><button type="button" onClick={() => navigate("/dashboard/profile/edit")} className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-400 transition hover:bg-white/10 hover:text-white">Edit Profile</button></div></div>
    </div>
  </section>;
}
