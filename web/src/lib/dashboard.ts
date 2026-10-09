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
  /** Alternate live-schema variant storing whole-dollar prices. */
  readonly price?: number | null;
  readonly image_url: string | null;
  readonly status?: string | null;
  readonly created_at: string | null;
}

interface IdeaRow {
  readonly id: string;
  readonly title: string | null;
  readonly pitch: string | null;
  readonly blurb?: string | null; // legacy column name on some deployments
  readonly category: string | null;
  readonly status: string | null;
  readonly created_at: string | null;
}

interface IdeaVoteRow {
  readonly idea_id: string;
  readonly choice: string | null;
}

/**
 * OWNERSHIP SOURCE OF TRUTH: `listings.user_id` / `ideas.user_id`.
 * The live database stores the creator's Supabase auth uid in `user_id`
 * (`owner_id` is NULL on real rows), and every RLS policy checks
 * `auth.uid() = user_id`. Frontend ownership logic therefore filters ONLY by
 * `user_id` — never owner_id/creator_id/email/username.
 */
const OWNER_COLUMN: string = "user_id";

const EMPTY_STATS: DashboardStats = Object.freeze({
  listingsPosted: 0,
  conceptsPosted: 0,
  validatedIdeas: 0,
  totalVotesReceived: 0,
});

/**
 * Plain (non-embedded) select filtered by the ownership source of truth.
 * 2nd-pass audit: filters ONLY on `user_id` — the ownerColumns indirection
 * that previously allowed legacy `owner_id` fallbacks was removed.
 */
async function selectOwnedRows<Row>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  userId: string,
): Promise<{ readonly rows: ReadonlyArray<Row>; readonly error: string | null }> {
  try {
    const res = await sb
      .from(table)
      .select(columns)
      .eq(OWNER_COLUMN, userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (res.error === null) {
      return { rows: Array.isArray(res.data) ? (res.data as unknown as Row[]) : [], error: null };
    }
    return { rows: [], error: res.error.message };
  } catch (err: unknown) {
    return { rows: [], error: err instanceof Error ? err.message : "Query failed" };
  }
}

/** Fetches the current user's listings + ideas and derives dashboard stats. */
export async function fetchCreatorDashboard(userId: string): Promise<DashboardResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: true, listings: Object.freeze([]), ideas: Object.freeze([]), stats: EMPTY_STATS };
  }

  try {
    // Two clean, separate queries — NO embedded joins like `idea_votes(choice)`
    // or `votes_count`, which PostgREST rejects when FK metadata is missing.
    // Query 1: the user's own listings, filtered by the ownership source of
    // truth (`user_id`). Plain columns with tolerant fallbacks (e.g. `price`
    // in dollars when `price_cents` is absent); never embedded joins/aliases.
    const listingCols = "id, title, description, blurb, category, price_cents, price, image_url, status, created_at, user_id";
    const listingsQ = await selectOwnedRows<ListingRow>(sb, "listings", listingCols, userId);
    // Query 2: the user's own concepts (`select('*')` so we never reference a
    // column that might not exist on the live table).
    const conceptsQ = await selectOwnedRows<IdeaRow>(sb, "ideas", "*", userId);

    if (listingsQ.error !== null && listingsQ.rows.length === 0) {
      return { ok: false, message: `Could not load your bizzes: ${listingsQ.error}` };
    }
    if (conceptsQ.error !== null && conceptsQ.rows.length === 0) {
      return { ok: false, message: `Could not load your concepts: ${conceptsQ.error}` };
    }

    const listingRows: ReadonlyArray<ListingRow> = listingsQ.rows;

    // AUDIT NOTE: the legacy `votes` table (listing_id-based) is NOT queried
    // anymore — it has no rows for our listings and its schema drifted to
    // idea_id. Listing vote counts stay 0 until a proper marketplace-votes
    // schema lands (deliberate honest zero, not fake data). Bizz/Fizz idea
    // validation counts come exclusively from `idea_votes` below.
    const votesByListing: Map<string, number> = new Map();

    const listings: ReadonlyArray<DashboardListing> = Object.freeze(
      listingRows.map((row: ListingRow): DashboardListing => ({
        id: row.id,
        title: row.title ?? "Untitled bizz",
        category: normalizeFeedCategory(row.category),
        priceCents:
          typeof row.price_cents === "number" && Number.isFinite(row.price_cents)
            ? Math.max(0, Math.round(row.price_cents))
            : typeof row.price === "number" && Number.isFinite(row.price)
              ? Math.max(0, Math.round(row.price * 100)) // dollars → cents
              : 0,
        imageUrl: row.image_url ?? null,
        votesCount: votesByListing.get(row.id) ?? 0,
        createdAt: row.created_at ?? new Date().toISOString(),
      })),
    );

    const ideaRows: ReadonlyArray<IdeaRow> = conceptsQ.rows;

    // Separate query for concept tallies: fetch the raw vote rows for these
    // ideas and count them client-side — again with no join/embedded select.
    const tallyByIdea: Map<string, { bizz: number; fizz: number }> = new Map();
    if (ideaRows.length > 0) {
      try {
        const ideaVotesRes = await sb
          .from("idea_votes")
          .select("idea_id, choice")
          .in("idea_id", ideaRows.map((row: IdeaRow): string => row.id))
          .limit(5000);
        if (ideaVotesRes.error === null && Array.isArray(ideaVotesRes.data)) {
          for (const v of ideaVotesRes.data as ReadonlyArray<IdeaVoteRow>) {
            const entry = tallyByIdea.get(v.idea_id) ?? { bizz: 0, fizz: 0 };
            if (v.choice === "bizz") entry.bizz += 1;
            else if (v.choice === "fizz") entry.fizz += 1;
            tallyByIdea.set(v.idea_id, entry);
          }
        }
      } catch {
        // Best effort — concepts still render with zeroed tallies.
      }
    }

    let conceptVotesTotal: number = 0;
    const ideas: ReadonlyArray<DashboardIdea> = Object.freeze(
      ideaRows.map((row: IdeaRow): DashboardIdea => {
        const counts = tallyByIdea.get(row.id) ?? { bizz: 0, fizz: 0 };
        conceptVotesTotal += counts.bizz + counts.fizz;
        return {
          id: row.id,
          title: row.title ?? "Untitled concept",
          pitch: row.pitch ?? row.blurb ?? "",
          category: normalizeFeedCategory(row.category),
          status: row.status ?? "open",
          tally: computeTally(counts.bizz, counts.fizz),
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
