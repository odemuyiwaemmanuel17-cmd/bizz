/**
 * Validation votes against Supabase `public.votes` (one row per user+listing).
 *
 * Submitting twice toggles the vote off, matching the Phase-1 API contract
 * (`POST /api/votes`). Falls back to an in-memory demo tally when Supabase is
 * not configured so the feed stays interactive offline.
 */

import { getSupabase } from "./supabase";
import { getSessionSafe, type AuthSnapshot } from "./supabase";

export interface VoteState {
  readonly voted: boolean;
  readonly votesCount: number;
}

export type VoteError = "not-authenticated" | "network" | "rejected";

export interface VoteResult {
  readonly ok: boolean;
  readonly state: VoteState;
  readonly error: VoteError | null;
}

/** In-memory toggle store for offline demo mode (module-scoped by design). */
const offlineVotes: Map<string, boolean> = new Map<string, boolean>();
const offlineBaseCounts: Map<string, number> = new Map<string, number>();

export function seedOfflineVotes(listingId: string, votesCount: number): void {
  if (!offlineBaseCounts.has(listingId)) offlineBaseCounts.set(listingId, votesCount);
}

function offlineState(listingId: string, userId: string): VoteState {
  const base: number = offlineBaseCounts.get(listingId) ?? 0;
  const key: string = `${userId}:${listingId}`;
  const voted: boolean = offlineVotes.get(key) === true;
  return Object.freeze({ voted, votesCount: Math.max(0, base + (voted ? 1 : 0)) });
}

async function currentVotedByMe(sb: NonNullable<ReturnType<typeof getSupabase>>, listingId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from("votes").select("user_id").eq("listing_id", listingId).eq("user_id", userId).maybeSingle();
    if (error !== null) return false;
    return data !== null && data !== undefined;
  } catch {
    return false;
  }
}

async function countVotes(sb: NonNullable<ReturnType<typeof getSupabase>>, listingId: string): Promise<number> {
  try {
    const { count, error } = await sb
      .from("votes")
      .select("listing_id", { count: "exact", head: true })
      .eq("listing_id", listingId);
    if (error !== null) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/** Read the caller's vote status for a listing without mutating anything. */
export async function fetchVoteState(listingId: string, fallbackCount: number): Promise<VoteState> {
  const snapshot: AuthSnapshot = await getSessionSafe();
  const userId: string | null = snapshot.user?.id ?? null;
  const sb = getSupabase();
  if (sb === null || userId === null) {
    seedOfflineVotes(listingId, fallbackCount);
    return offlineState(listingId, userId ?? "guest");
  }
  try {
    const [voted, total] = await Promise.all([currentVotedByMe(sb, listingId, userId), countVotes(sb, listingId)]);
    return Object.freeze({ voted, votesCount: total });
  } catch {
    return Object.freeze({ voted: false, votesCount: fallbackCount });
  }
}

/**
 * Toggle the signed-in user's validation vote. Returns the new state plus an
 * error tag when the write failed; never throws.
 */
export async function submitVote(listingId: string, fallbackCount: number): Promise<VoteResult> {
  const snapshot: AuthSnapshot = await getSessionSafe();
  const userId: string | null = snapshot.user?.id ?? null;
  const sb = getSupabase();

  if (sb === null) {
    // Offline demo: allow anonymous toggling of the seeded tally.
    const key: string = `guest:${listingId}`;
    seedOfflineVotes(listingId, fallbackCount);
    const next: boolean = offlineVotes.get(key) !== true;
    if (next) offlineVotes.set(key, true);
    else offlineVotes.delete(key);
    return Object.freeze({ ok: true, state: offlineState(listingId, "guest"), error: null });
  }

  if (userId === null) {
    return Object.freeze({ ok: false, state: Object.freeze({ voted: false, votesCount: fallbackCount }), error: "not-authenticated" as const });
  }

  try {
    const already: boolean = await currentVotedByMe(sb, listingId, userId);
    if (already) {
      const { error } = await sb.from("votes").delete().eq("listing_id", listingId).eq("user_id", userId);
      if (error !== null) {
        return Object.freeze({ ok: false, state: Object.freeze({ voted: true, votesCount: await countVotes(sb, listingId) }), error: "rejected" as const });
      }
    } else {
      const { error } = await sb.from("votes").insert({ listing_id: listingId, user_id: userId });
      if (error !== null) {
        return Object.freeze({ ok: false, state: Object.freeze({ voted: false, votesCount: await countVotes(sb, listingId) }), error: "rejected" as const });
      }
    }
    const total: number = await countVotes(sb, listingId);
    return Object.freeze({ ok: true, state: Object.freeze({ voted: !already, votesCount: total }), error: null });
  } catch {
    return Object.freeze({
      ok: false,
      state: Object.freeze({ voted: false, votesCount: fallbackCount }),
      error: "network" as const,
    });
  }
}
