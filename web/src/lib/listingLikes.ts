/**
 * Marketplace listing likes — public.listing_likes.
 *
 * Product contract (DO NOT MIX SYSTEMS):
 *   Validation arena:  ideas      → idea_votes    → bizz / fizz
 *   Discover feed:     listings   → listing_likes → heart / like
 *
 * Schema of public.listing_likes:
 *   id uuid, listing_id uuid, user_id uuid, created_at timestamptz
 *   UNIQUE (listing_id, user_id)  ← one like per user per listing
 *
 * Like counts are ALWAYS derived from real rows in listing_likes; the stale
 * `listings.votes_count` column is intentionally ignored here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export interface ListingLikeSnapshot {
  /** Number of users who liked each listing (from listing_likes rows). */
  readonly counts: ReadonlyMap<string, number>;
  /** Listing ids the CURRENT authenticated user has liked. */
  readonly mine: ReadonlySet<string>;
}

const EMPTY_SNAPSHOT: ListingLikeSnapshot = Object.freeze({
  counts: new Map<string, number>(),
  mine: new Set<string>(),
});

interface ListingLikeRow {
  readonly listing_id?: string | null;
  readonly user_id?: string | null;
}

/**
 * Load live like counts + the current user's own like state for a batch of
 * listing ids. Never throws: on network/RLS failure returns an empty snapshot
 * (honest zeros) and logs a developer message.
 */
export async function fetchListingLikes(
  listingIds: ReadonlyArray<string>,
): Promise<ListingLikeSnapshot> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null || listingIds.length === 0) return EMPTY_SNAPSHOT;

  try {
    // Server-verified uid so `mine` matches exactly what RLS considers auth.uid().
    const { data: userData, error: userError } = await sb.auth.getUser();
    if (userError !== null && userError !== undefined) {
      console.warn("[bizz] listing likes: getUser failed", userError.message);
    }
    const userId: string | null = userData.user?.id ?? null;

    const { data, error } = await sb
      .from("listing_likes")
      .select("listing_id, user_id")
      .in("listing_id", [...listingIds]);

    if (error !== null && error !== undefined) {
      console.warn("[bizz] listing likes query failed:", error.message);
      return EMPTY_SNAPSHOT;
    }

    const counts = new Map<string, number>();
    const mine = new Set<string>();
    const rows: ReadonlyArray<ListingLikeRow> = Array.isArray(data) ? (data as ListingLikeRow[]) : [];
    for (const row of rows) {
      const lid: string | null = typeof row.listing_id === "string" ? row.listing_id : null;
      if (lid === null) continue;
      counts.set(lid, (counts.get(lid) ?? 0) + 1);
      if (userId !== null && row.user_id === userId) mine.add(lid);
    }
    return Object.freeze({ counts, mine });
  } catch (err: unknown) {
    console.warn("[bizz] listing likes unexpected failure", err);
    return EMPTY_SNAPSHOT;
  }
}

export type ToggleLikeResult =
  | { readonly ok: true; readonly liked: boolean }
  | { readonly ok: false; readonly reason: "auth-required" | "offline" | "error"; readonly message: string };

/**
 * Toggle the current user's like on a listing.
 *
 * - Not logged in        → auth-required feedback (caller shows it).
 * - Already liked        → DELETE the (listing_id, user_id) row → unlike.
 * - Not liked yet        → INSERT { listing_id, user_id } (UNIQUE constraint
 *                          makes duplicates impossible; a 23505 conflict is
 *                          treated as "already liked").
 */
export async function toggleListingLike(listingId: string): Promise<ToggleLikeResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: false, reason: "offline", message: "Supabase is not configured, so likes can't be saved." };
  }

  let userId: string | null = null;
  try {
    const { data, error } = await sb.auth.getUser();
    if (error !== null && error !== undefined) {
      console.warn("[bizz] like toggle: getUser failed", error.message);
    }
    userId = data.user?.id ?? null;
  } catch (err: unknown) {
    console.warn("[bizz] like toggle: getUser threw", err);
    return { ok: false, reason: "error", message: "Could not verify your session. Please try again." };
  }
  if (userId === null) {
    return { ok: false, reason: "auth-required", message: "Sign in to like a Bizz." };
  }

  try {
    // Current state decides insert vs delete (no blind inserts → no dupes).
    const { data: existing, error: readError } = await sb
      .from("listing_likes")
      .select("listing_id")
      .eq("listing_id", listingId)
      .eq("user_id", userId)
      .maybeSingle();

    if (readError !== null && readError !== undefined) {
      console.error("[bizz] like toggle read failed:", readError.message, readError.code);
      return { ok: false, reason: "error", message: `Could not load your like status (${readError.message}).` };
    }

    if (existing !== null && existing !== undefined) {
      const { error: delError } = await sb
        .from("listing_likes")
        .delete()
        .eq("listing_id", listingId)
        .eq("user_id", userId);
      if (delError !== null && delError !== undefined) {
        console.error("[bizz] unlike failed:", delError.message, delError.code);
        return { ok: false, reason: "error", message: `Could not remove your like (${delError.message}).` };
      }
      return { ok: true, liked: false };
    }

    const { error: insError } = await sb.from("listing_likes").insert({
      listing_id: listingId,
      user_id: userId,
    });
    if (insError !== null && insError !== undefined) {
      // 23505 = unique violation → someone (this user, another tab) already liked it.
      if (insError.code === "23505") return { ok: true, liked: true };
      console.error("[bizz] like insert failed:", insError.message, insError.code);
      return { ok: false, reason: "error", message: `Could not save your like (${insError.message}).` };
    }
    return { ok: true, liked: true };
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Unknown error";
    console.error("[bizz] like toggle threw", err);
    return { ok: false, reason: "error", message: `Could not update your like (${message}).` };
  }
}
