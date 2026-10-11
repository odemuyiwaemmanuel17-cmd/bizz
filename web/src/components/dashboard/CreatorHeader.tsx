/**
 * Creator identity header for the dashboard top area.
 * Replaces the old "Sign out & clear session" button with real profile
 * data from public.profiles plus profile controls (View / Edit / Upload).
 * All values come from Supabase — nothing is invented; missing fields
 * render honest fallbacks or a username-setup CTA.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "../../lib/supabase";

interface ProfileRow {
  readonly id: string;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly handle: string | null;
  readonly bio: string | null;
  readonly avatar_url: string | null;
  readonly creator_type: string | null;
  readonly campus: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly is_verified: boolean | null;
}

interface CreatorIdentity {
  readonly username: string | null;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarUrl: string | null;
  readonly line2: string | null; // creator_type • campus/location
  readonly verified: boolean;
}

function identityFrom(row: ProfileRow | null, user: User): CreatorIdentity {
  const emailName: string = (user.email ?? "").split("@")[0] ?? "";
  const displayName: string =
    row?.display_name ?? user.user_metadata?.["full_name"] ?? emailName ?? "Creator";
  const parts: string[] = [];
  if (row?.creator_type) parts.push(row.creator_type);
  const location: string | null =
    row?.campus ?? ([row?.state, row?.country].filter((v): v is string => Boolean(v)).join(", ") || null);
  if (location) parts.push(location);
  return {
    username: row?.username ?? row?.handle ?? null,
    displayName,
    bio: row?.bio ?? null,
    avatarUrl: row?.avatar_url ?? user.user_metadata?.["avatar_url"] ?? null,
    line2: parts.length > 0 ? parts.join(" • ") : null,
    verified: row?.is_verified === true,
  };
}

export function CreatorHeader({
  user,
  onRefresh,
}: {
  readonly user: User;
  readonly onRefresh?: () => void;
}): ReactElement {
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);

  const loadProfile = useCallback(async (): Promise<void> => {
    const sb = getSupabase();
    if (sb === null) {
      setLoaded(true);
      return;
    }
    try {
      const { data, error } = await sb
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();
      if (error) console.error("[CreatorHeader] profile load failed:", error.message);
      setProfile((data as ProfileRow | null) ?? null);
    } catch (err) {
      console.error("[CreatorHeader] unexpected profile fetch error:", err);
    } finally {
      setLoaded(true);
    }
  }, [user.id]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const identity: CreatorIdentity = identityFrom(profile, user);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Identity block */}
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-violetGlow/40 bg-gradient-to-br from-indigoGlow/30 to-violetGlow/30">
            {identity.avatarUrl !== null && loaded ? (
              <img src={identity.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-2xl font-black text-white/80">
                {identity.displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-lg font-bold text-white">
              {identity.displayName}
              {identity.verified && (
                <span title="Verified creator" className="text-cyan-300">✓</span>
              )}
            </p>
            {identity.username !== null ? (
              <p className="truncate text-sm text-slate-400">@{identity.username}</p>
            ) : (
              <Link
                to="/dashboard?tab=profile"
                className="text-xs font-medium text-amber-300 underline-offset-2 hover:underline"
              >
                Set up your @username →
              </Link>
            )}
            {identity.line2 !== null && (
              <p className="mt-0.5 truncate text-xs text-slate-400">{identity.line2}</p>
            )}
            {identity.bio !== null && (
              <p className="mt-1 line-clamp-2 max-w-md text-xs text-slate-500">{identity.bio}</p>
            )}
          </div>
        </div>

        {/* Profile controls (replace the removed sign-out button) */}
        <div className="flex flex-wrap items-center gap-2">
          {identity.username !== null ? (
            <Link
              to={`/@${identity.username}`}
              className="btn-glass rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:brightness-125 active:scale-95"
            >
              View Profile
            </Link>
          ) : (
            <Link
              to="/dashboard?tab=profile"
              className="btn-glass rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:brightness-125 active:scale-95"
            >
              View Profile
            </Link>
          )}
          <Link
            to="/dashboard?tab=profile"
            onClick={() => void loadProfile()}
            className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/10 active:scale-95"
          >
            Edit Profile
          </Link>
          <button
            type="button"
            onClick={() => onRefresh?.()}
            className="rounded-full bg-gradient-to-r from-indigoGlow to-violetGlow px-4 py-2 text-sm font-semibold text-white shadow transition hover:brightness-110 active:scale-95"
          >
            + Upload Video
          </button>
        </div>
      </div>
    </div>
  );
}
