import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export interface SocialComment { readonly id: string; readonly videoId: string; readonly userId: string; readonly body: string; readonly createdAt: string; readonly username: string | null; readonly avatarUrl: string | null; }
export interface VideoSocialState { readonly likes: number; readonly liked: boolean; readonly saved: boolean; readonly comments: ReadonlyArray<SocialComment>; }
const empty: VideoSocialState = { likes: 0, liked: false, saved: false, comments: [] };

async function clientUser(sb: SupabaseClient): Promise<string | null> { const result = await sb.auth.getUser(); return result.data.user?.id ?? null; }
export async function fetchVideoSocial(videoId: string): Promise<VideoSocialState> {
  const sb = getSupabase(); if (sb === null) return empty;
  const userId = await clientUser(sb);
  const [likes, mine, saved, comments] = await Promise.all([
    sb.from("video_likes").select("id", { count: "exact", head: true }).eq("video_id", videoId),
    userId === null ? Promise.resolve({ data: [], error: null }) : sb.from("video_likes").select("id").eq("video_id", videoId).eq("user_id", userId),
    userId === null ? Promise.resolve({ data: [], error: null }) : sb.from("saved_videos").select("id").eq("video_id", videoId).eq("user_id", userId),
    sb.from("video_comments").select("id,video_id,user_id,body,created_at").eq("video_id", videoId).order("created_at", { ascending: false }).limit(50),
  ]);
  const rows = (comments.data ?? []) as Array<{ id: string; video_id: string; user_id: string; body: string; created_at: string }>;
  const profileIds = Array.from(new Set(rows.map((row) => row.user_id)));
  const profileResult = profileIds.length === 0 ? { data: [] } : await sb.from("profiles").select("id,username,avatar_url").in("id", profileIds);
  const profiles = new Map<string, { username?: string | null; avatar_url?: string | null }>();
  for (const profile of (profileResult.data ?? []) as Array<{ id: string; username?: string | null; avatar_url?: string | null }>) profiles.set(profile.id, profile);
  return { likes: likes.count ?? 0, liked: (mine.data ?? []).length > 0, saved: (saved.data ?? []).length > 0, comments: rows.map((row) => ({ id: row.id, videoId: row.video_id, userId: row.user_id, body: row.body, createdAt: row.created_at, username: profiles.get(row.user_id)?.username ?? null, avatarUrl: profiles.get(row.user_id)?.avatar_url ?? null })) };
}
export async function toggleVideoLike(videoId: string, liked: boolean): Promise<void> { const sb = getSupabase(); if (sb === null) throw new Error("Supabase is not configured."); const userId = await clientUser(sb); if (userId === null) throw new Error("Sign in to like videos."); const result = liked ? await sb.from("video_likes").delete().eq("video_id", videoId).eq("user_id", userId) : await sb.from("video_likes").insert({ video_id: videoId, user_id: userId }); if (result.error) throw new Error(result.error.message); }
export async function toggleSavedVideo(videoId: string, saved: boolean): Promise<void> { const sb = getSupabase(); if (sb === null) throw new Error("Supabase is not configured."); const userId = await clientUser(sb); if (userId === null) throw new Error("Sign in to save videos."); const result = saved ? await sb.from("saved_videos").delete().eq("video_id", videoId).eq("user_id", userId) : await sb.from("saved_videos").insert({ video_id: videoId, user_id: userId }); if (result.error) throw new Error(result.error.message); }
export async function addVideoComment(videoId: string, body: string): Promise<void> { const sb = getSupabase(); if (sb === null) throw new Error("Supabase is not configured."); const userId = await clientUser(sb); if (userId === null) throw new Error("Sign in to comment."); const text = body.trim(); if (text.length < 1 || text.length > 500) throw new Error("Comment must be between 1 and 500 characters."); const result = await sb.from("video_comments").insert({ video_id: videoId, user_id: userId, body: text }); if (result.error) throw new Error(result.error.message); }
export async function deleteVideoComment(commentId: string): Promise<void> { const sb = getSupabase(); if (sb === null) throw new Error("Supabase is not configured."); const result = await sb.from("video_comments").delete().eq("id", commentId); if (result.error) throw new Error(result.error.message); }
export async function toggleCreatorFollow(creatorId: string, following: boolean): Promise<void> { const sb = getSupabase(); if (sb === null) throw new Error("Supabase is not configured."); const followerId = await clientUser(sb); if (followerId === null) throw new Error("Sign in to follow creators."); if (creatorId === followerId) throw new Error("You cannot follow yourself."); const result = following ? await sb.from("creator_follows").delete().eq("creator_id", creatorId).eq("follower_id", followerId) : await sb.from("creator_follows").insert({ creator_id: creatorId, follower_id: followerId }); if (result.error) throw new Error(result.error.message); }
export async function fetchFollowState(creatorId: string): Promise<{ followers: number; followingCount: number; following: boolean }> { const sb = getSupabase(); if (sb === null) return { followers: 0, followingCount: 0, following: false }; const userId = await clientUser(sb); const [count, followingCount, mine] = await Promise.all([sb.from("creator_follows").select("id", { count: "exact", head: true }).eq("creator_id", creatorId), sb.from("creator_follows").select("id", { count: "exact", head: true }).eq("follower_id", creatorId), userId === null ? Promise.resolve({ data: [] }) : sb.from("creator_follows").select("id").eq("creator_id", creatorId).eq("follower_id", userId)]); return { followers: count.count ?? 0, followingCount: followingCount.count ?? 0, following: (mine.data ?? []).length > 0 }; }
