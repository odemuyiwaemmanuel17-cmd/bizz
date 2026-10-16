import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "../../lib/supabase";
import { ProfileModal, VideoUploadModal, type CreatorProfileData } from "./CreatorModals";

interface ProfileRow {
  readonly id: string; readonly username: string | null; readonly display_name: string | null;
  readonly bio: string | null; readonly avatar_url: string | null; readonly creator_type: string | null;
  readonly campus: string | null; readonly state: string | null; readonly country: string | null; readonly is_verified: boolean | null;
}

function toProfile(row: ProfileRow | null): CreatorProfileData | null {
  if (row === null) return null;
  return { id: row.id, username: row.username ?? "", display_name: row.display_name ?? "", bio: row.bio ?? "", avatar_url: row.avatar_url ?? "", creator_type: row.creator_type ?? "", campus: row.campus ?? "", state: row.state ?? "", country: row.country ?? "", is_verified: row.is_verified === true };
}

export function CreatorHeader({ user, onRefresh }: { readonly user: User; readonly onRefresh?: () => void }): ReactElement {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState<"setup" | "edit" | "video" | null>(null);
  const loadProfile = useCallback(async (): Promise<void> => {
    const sb = getSupabase();
    if (sb === null) { setLoaded(true); return; }
    try { const result = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle(); if (result.error) console.error("[CreatorHeader] profile load failed:", result.error.message); setProfile((result.data as ProfileRow | null) ?? null); } catch (error) { console.error("[CreatorHeader] profile load failed:", error); } finally { setLoaded(true); }
  }, [user.id]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);
  const displayName = profile?.display_name ?? String(user.user_metadata?.["full_name"] ?? user.email?.split("@")[0] ?? "Creator");
  const username = profile?.username ?? null;
  const location = profile?.campus ?? [profile?.state, profile?.country].filter(Boolean).join(", ");
  const saved = (next: CreatorProfileData): void => { setProfile(next); setModal(null); onRefresh?.(); };
  return <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur sm:p-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-4"><div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-violetGlow/40 bg-gradient-to-br from-indigoGlow/30 to-violetGlow/30">{profile?.avatar_url && loaded ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center text-2xl font-black text-white/80">{displayName.charAt(0).toUpperCase()}</span>}</div><div className="min-w-0"><p className="truncate text-lg font-bold text-white">{displayName}{profile?.is_verified === true && <span className="ml-1.5 text-cyan-300" title="Verified creator">✓</span>}</p>{username ? <p className="truncate text-sm text-slate-400">@{username}</p> : <button type="button" onClick={() => setModal("setup")} className="text-xs font-medium text-amber-300 hover:underline">Set up your @username →</button>}{location && <p className="mt-0.5 truncate text-xs text-slate-400">{profile?.creator_type ? `${profile.creator_type} • ` : ""}{location}</p>}{profile?.bio && <p className="mt-1 line-clamp-2 max-w-md text-xs text-slate-500">{profile.bio}</p>}</div></div>
      <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => username ? navigate(`/@${username}`) : setModal("setup")} className="btn-glass rounded-full px-4 py-2 text-sm font-semibold text-white">View Profile</button><button type="button" onClick={() => setModal("edit")} className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-200">Edit Profile</button><button type="button" onClick={() => setModal("video")} className="rounded-full bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2 text-sm font-semibold text-white shadow">+ Upload Video</button></div>
    </div>
    {modal === "setup" && <ProfileModal user={user} initial={toProfile(profile)} setupOnly onSaved={saved} onClose={() => setModal(null)} />}
    {modal === "edit" && <ProfileModal user={user} initial={toProfile(profile)} onSaved={saved} onClose={() => setModal(null)} />}
    {modal === "video" && <VideoUploadModal user={user} onPublished={() => onRefresh?.()} onClose={() => setModal(null)} />}
  </div>;
}
