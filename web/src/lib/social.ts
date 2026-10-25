import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export interface SocialComment {
  readonly id: string;
  readonly videoId: string;
  readonly userId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
}

export interface VideoSocialState {
  readonly likes: number;
  readonly liked: boolean;
  readonly saved: boolean;
  readonly comments: ReadonlyArray<SocialComment>;
  readonly commentCount: number;
}

export interface CreatorSummary {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

const empty: VideoSocialState = { likes: 0, liked: false, saved: false, comments: [], commentCount: 0 };

async function clientUser(sb: SupabaseClient): Promise<string | null> {
  const result = await sb.auth.getUser();
  return result.data.user?.id ?? null;
}

export function validateCommentBody(body: string): string {
  const text = body.trim();
  if (text.length < 1 || text.length > 500) throw new Error("Comment must be between 1 and 500 characters.");
  return text;
}

export async function fetchVideoSocial(videoId: string): Promise<VideoSocialState> {
  const sb = getSupabase();
  if (sb === null) return empty;
  const userId = await clientUser(sb);
  const [likes, mine, saved, comments] = await Promise.all([
    sb.from("video_likes").select("id", { count: "exact", head: true }).eq("video_id", videoId),
    userId === null ? Promise.resolve({ data: [], error: null }) : sb.from("video_likes").select("id").eq("video_id", videoId).eq("user_id", userId),
    userId === null ? Promise.resolve({ data: [], error: null }) : sb.from("saved_videos").select("id").eq("video_id", videoId).eq("user_id", userId),
    sb.from("video_comments").select("id,video_id,user_id,body,created_at,updated_at", { count: "exact" }).eq("video_id", videoId).order("created_at", { ascending: false }).limit(50),
  ]);
  if (comments.error !== null) throw new Error(comments.error.message);
  const rows = (comments.data ?? []) as Array<{ id: string; video_id: string; user_id: string; body: string; created_at: string; updated_at?: string | null }>;
  const profileIds = Array.from(new Set(rows.map((row) => row.user_id)));
  const profileResult = profileIds.length === 0 ? { data: [], error: null } : await sb.from("profiles").select("id,username,handle,display_name,full_name,avatar_url").in("id", profileIds);
  if (profileResult.error !== null) throw new Error(profileResult.error.message);
  const profiles = new Map<string, { username?: string | null; handle?: string | null; display_name?: string | null; full_name?: string | null; avatar_url?: string | null }>();
  for (const profile of (profileResult.data ?? []) as Array<{ id: string; username?: string | null; handle?: string | null; display_name?: string | null; full_name?: string | null; avatar_url?: string | null }>) profiles.set(profile.id, profile);
  return {
    likes: likes.count ?? 0,
    liked: (mine.data ?? []).length > 0,
    saved: (saved.data ?? []).length > 0,
    commentCount: comments.count ?? rows.length,
    comments: rows.map((row) => {
      const profile = profiles.get(row.user_id);
      return {
        id: row.id,
        videoId: row.video_id,
        userId: row.user_id,
        body: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? row.created_at,
        username: profile?.username ?? profile?.handle ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      };
    }),
  };
}

export async function toggleVideoLike(videoId: string, liked: boolean): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to like videos.");
  const result = liked ? await sb.from("video_likes").delete().eq("video_id", videoId).eq("user_id", userId) : await sb.from("video_likes").insert({ video_id: videoId, user_id: userId });
  if (result.error) throw new Error(result.error.message);
}

export async function toggleSavedVideo(videoId: string, saved: boolean): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to save videos.");
  const result = saved ? await sb.from("saved_videos").delete().eq("video_id", videoId).eq("user_id", userId) : await sb.from("saved_videos").insert({ video_id: videoId, user_id: userId });
  if (result.error) throw new Error(result.error.message);
}

export async function addVideoComment(videoId: string, body: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to comment.");
  const result = await sb.from("video_comments").insert({ video_id: videoId, user_id: userId, body: validateCommentBody(body) });
  if (result.error) throw new Error(result.error.message);
}

export async function updateVideoComment(commentId: string, body: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to edit comments.");
  const result = await sb.from("video_comments").update({ body: validateCommentBody(body) }).eq("id", commentId).eq("user_id", userId);
  if (result.error) throw new Error(result.error.message);
}

export async function deleteVideoComment(commentId: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to delete comments.");
  const result = await sb.from("video_comments").delete().eq("id", commentId).eq("user_id", userId);
  if (result.error) throw new Error(result.error.message);
}

export async function reportVideoComment(commentId: string, reason: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const userId = await clientUser(sb);
  if (userId === null) throw new Error("Sign in to report comments.");
  const text = reason.trim();
  if (text.length < 1 || text.length > 500) throw new Error("Report reason must be between 1 and 500 characters.");
  const result = await sb.from("video_comment_reports").insert({ comment_id: commentId, reporter_id: userId, reason: text });
  if (result.error) throw new Error(result.error.message);
}

export async function toggleCreatorFollow(creatorId: string, following: boolean): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const followerId = await clientUser(sb);
  if (followerId === null) throw new Error("Sign in to follow creators.");
  if (creatorId === followerId) throw new Error("You cannot follow yourself.");
  const result = following ? await sb.from("creator_follows").delete().eq("creator_id", creatorId).eq("follower_id", followerId) : await sb.from("creator_follows").insert({ creator_id: creatorId, follower_id: followerId });
  if (result.error) throw new Error(result.error.message);
}

export async function fetchFollowState(creatorId: string): Promise<{ followers: number; followingCount: number; following: boolean }> {
  const sb = getSupabase();
  if (sb === null) return { followers: 0, followingCount: 0, following: false };
  const userId = await clientUser(sb);
  const [count, followingCount, mine] = await Promise.all([
    sb.from("creator_follows").select("id", { count: "exact", head: true }).eq("creator_id", creatorId),
    sb.from("creator_follows").select("id", { count: "exact", head: true }).eq("follower_id", creatorId),
    userId === null ? Promise.resolve({ data: [] }) : sb.from("creator_follows").select("id").eq("creator_id", creatorId).eq("follower_id", userId),
  ]);
  if (count.error || followingCount.error || ("error" in mine && mine.error)) throw new Error(count.error?.message ?? followingCount.error?.message ?? ("error" in mine ? mine.error?.message : "Follow state could not be loaded") ?? "Follow state could not be loaded");
  return { followers: count.count ?? 0, followingCount: followingCount.count ?? 0, following: (mine.data ?? []).length > 0 };
}

export async function fetchFollowingCreatorIds(): Promise<string[]> {
  const sb = getSupabase();
  if (sb === null) return [];
  const userId = await clientUser(sb);
  if (userId === null) return [];
  const result = await sb.from("creator_follows").select("creator_id").eq("follower_id", userId);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).map((row) => String((row as { creator_id: string }).creator_id));
}

export async function fetchCreatorNetwork(creatorId: string, relation: "followers" | "following"): Promise<CreatorSummary[]> {
  const sb = getSupabase();
  if (sb === null) return [];
  const key = relation === "followers" ? "follower_id" : "creator_id";
  const result = await sb.from("creator_follows").select("creator_id,follower_id").eq(relation === "followers" ? "creator_id" : "follower_id", creatorId).order("created_at", { ascending: false }).limit(100);
  if (result.error) throw new Error(result.error.message);
  const ids = (result.data ?? []).map((row) => String((row as Record<string, string>)[key])).filter(Boolean);
  if (ids.length === 0) return [];
  const profiles = await sb.from("profiles").select("id,username,handle,display_name,full_name,avatar_url").in("id", ids);
  if (profiles.error) throw new Error(profiles.error.message);
  const byId = new Map<string, CreatorSummary>();
  for (const row of (profiles.data ?? []) as Array<{ id: string; username?: string | null; handle?: string | null; display_name?: string | null; full_name?: string | null; avatar_url?: string | null }>) byId.set(row.id, { id: row.id, username: row.username ?? row.handle ?? null, displayName: row.display_name ?? row.full_name ?? "Creator", avatarUrl: row.avatar_url ?? null });
  return ids.map((id) => byId.get(id)).filter((row): row is CreatorSummary => row !== undefined);
}
