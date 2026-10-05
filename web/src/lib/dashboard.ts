/**
 * Creator dashboard data layer.
 *
 * Aggregates everything the signed-in user has published:
 *  - listings (ready-to-sell bizzes) with vote counts
 *  - ideas (concepts in Bizz/Fizz validation) with live tallies
 *  - headline stats (total posts, validated count, total votes received)
 *
 * When Supabase is not configured (offline demo mode) it returns empty
 * results rather than throwing, so the dashboard UI can render a
 * "publish your first bizz" state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { computeTally, isValidated, type SentimentTally } from "./ideas";
import { normalizeFeedCategory, type FeedCategory } from "./feed";

export interface DashboardListing {
  readonly id: string;
  readonly title: string;
  readonly category: FeedCategory;
  readonly priceCents: number;
  readonly imageUrl: string | null;
  readonly votesCount: number;
  readonly createdAt: string;
}

export interface DashboardIdea {
  readonly id: string;
  readonly title: string;
  readonly pitch: string;
  readonly category: FeedCategory;
  readonly status: string;
  readonly tally: SentimentTally;
  readonly createdAt: string;
}

export interface DashboardStats {
  readonly listingsPosted: number;
  readonly conceptsPosted: number;
  readonly validatedIdeas: number;
  readonly totalVotesReceived: number;
}

export type DashboardResult =
  | { readonly ok: true; readonly listings: ReadonlyArray<DashboardListing>; readonly ideas: ReadonlyArray<DashboardIdea>; readonly stats: DashboardStats }
  | { readonly ok: false; readonly message: string };

interface ListingRow {
  readonly id: string;
  readonly title: string | null;
  readonly category: string | null;
  readonly price_cents: number | null;
  readonly image_url: string | null;
  readonly created_at: string | null;
  readonly votes_count: number | null;
}

interface IdeaRow {
  readonly id: string;
  readonly title: string | null;
  readonly pitch: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly created_at: string | null;
  readonly idea_votes?: Array<{ readonly choice: string | null }>;
}

const EMPTY_STATS: DashboardStats = Object.freeze({
  listingsPosted: 0,
  conceptsPosted: 0,
  validatedIdeas: 0,
  totalVotesReceived: 0,
});

/** Fetches the current user's listings + ideas and derives dashboard stats. */
export async function fetchCreatorDashboard(userId: string): Promise<DashboardResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: true, listings: Object.freeze([]), ideas: Object.freeze([]), stats: EMPTY_STATS };
  }

  try {
    const [listingsRes, ideasRes] = await Promise.all([
      sb
        .from("listings")
        .select("id, title, category, price_cents, image_url, created_at, votes_count")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false })
        .limit(100),
      sb
        .from("ideas")
        .select("id, title, pitch, category, status, created_at, idea_votes(choice)")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    if (listingsRes.error !== null) {
      return { ok: false, message: `Could not load your bizzes: ${listingsRes.error.message}` };
    }
    if (ideasRes.error !== null) {
      return { ok: false, message: `Could not load your concepts: ${ideasRes.error.message}` };
    }

    const listingRows: ReadonlyArray<ListingRow> = Array.isArray(listingsRes.data)
      ? (listingsRes.data as unknown as ListingRow[])
      : [];
    const listings: ReadonlyArray<DashboardListing> = Object.freeze(
      listingRows.map((row: ListingRow): DashboardListing => ({
        id: row.id,
        title: row.title ?? "Untitled bizz",
        category: normalizeFeedCategory(row.category),
        priceCents: typeof row.price_cents === "number" && Number.isFinite(row.price_cents) ? Math.max(0, Math.round(row.price_cents)) : 0,
        imageUrl: row.image_url ?? null,
        votesCount: typeof row.votes_count === "number" && Number.isFinite(row.votes_count) ? Math.max(0, Math.round(row.votes_count)) : 0,
        createdAt: row.created_at ?? new Date().toISOString(),
      })),
    );

    const ideaRows: ReadonlyArray<IdeaRow> = Array.isArray(ideasRes.data)
      ? (ideasRes.data as unknown as IdeaRow[])
      : [];
    let conceptVotesTotal: number = 0;
    const ideas: ReadonlyArray<DashboardIdea> = Object.freeze(
      ideaRows.map((row: IdeaRow): DashboardIdea => {
        const choices: ReadonlyArray<string | null> = Array.isArray(row.idea_votes)
          ? row.idea_votes.map((v) => v.choice)
          : [];
        const bizz: number = choices.filter((c) => c === "bizz").length;
        const fizz: number = choices.filter((c) => c === "fizz").length;
        conceptVotesTotal += bizz + fizz;
        return {
          id: row.id,
          title: row.title ?? "Untitled concept",
          pitch: row.pitch ?? "",
          category: normalizeFeedCategory(row.category),
          status: row.status ?? "open",
          tally: computeTally(bizz, fizz),
          createdAt: row.created_at ?? new Date().toISOString(),
        };
      }),
    );

    const validatedIdeas: number = ideas.filter(
      (idea: DashboardIdea): boolean => idea.status === "validated" || isValidated(idea.tally),
    ).length;

    const stats: DashboardStats = Object.freeze({
      listingsPosted: listings.length,
      conceptsPosted: ideas.length,
      validatedIdeas,
      totalVotesReceived: listings.reduce((sum: number, l: DashboardListing): number => sum + l.votesCount, 0) + conceptVotesTotal,
    });

    return { ok: true, listings, ideas, stats };
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Unknown dashboard error";
    return { ok: false, message };
  }
}
