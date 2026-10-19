import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export interface PublicVideo {
  readonly id: string;
  readonly videoUrl: string;
  readonly caption: string | null;
  readonly createdAt: string;
  readonly creatorId: string;
  readonly username: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly listingId: string | null;
}

export interface VideoFeedResult {
  readonly items: ReadonlyArray<PublicVideo>;
  readonly hasMore: boolean;
  readonly error: string | null;
}

const PAGE_SIZE = 8;

export async function fetchPublicVideos(page: number): Promise<VideoFeedResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return { items: [], hasMore: false, error: "Supabase is not configured." };
  const from = Math.max(0, page) * PAGE_SIZE;
  try {
    const result = await sb.from("creator_videos")
      .select("id,user_id,video_url,caption,created_at,status,listing_id", { count: "exact" })
      .eq("status", "published")
      .not("video_url", "is", null)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error !== null) return { items: [], hasMore: false, error: result.error.message };
    const rows = (result.data ?? []) as Array<{ id: string; user_id: string; video_url: string; caption: string | null; created_at: string; status: string; listing_id: string | null }>;
    const creatorIds = Array.from(new Set(rows.map((row) => row.user_id).filter(Boolean)));
    const profiles = creatorIds.length === 0 ? { data: [], error: null } : await sb.from("profiles").select("id,username,display_name,full_name,avatar_url").in("id", creatorIds);
    const byId = new Map<string, { username: string | null; display_name: string | null; full_name: string | null; avatar_url: string | null }>();
    for (const profile of (profiles.data ?? []) as Array<{ id: string; username?: string | null; display_name?: string | null; full_name?: string | null; avatar_url?: string | null }>) byId.set(profile.id, { username: profile.username ?? null, display_name: profile.display_name ?? null, full_name: profile.full_name ?? null, avatar_url: profile.avatar_url ?? null });
    const items: PublicVideo[] = rows.map((row) => {
      const profile = byId.get(row.user_id);
      return { id: row.id, videoUrl: row.video_url, caption: row.caption, createdAt: row.created_at, creatorId: row.user_id, username: profile?.username ?? null, displayName: profile?.display_name ?? profile?.full_name ?? "Creator", avatarUrl: profile?.avatar_url ?? null, listingId: row.listing_id ?? null };
    });
    return { items, hasMore: rows.length === PAGE_SIZE, error: profiles.error?.message ?? null };
  } catch (error) {
    return { items: [], hasMore: false, error: error instanceof Error ? error.message : "Videos could not be loaded." };
  }
}
