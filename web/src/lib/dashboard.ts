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
 * Owner columns present on the live `ideas` table differ across deployments
 * (schema drift). We filter with explicit `.eq()` calls per candidate column
 * and keep whichever query returns rows — no embedded joins involved.
 */
const IDEA_OWNER_COLUMNS: ReadonlyArray<string> = ["owner_id", "user_id"];
const LISTING_OWNER_COLUMNS: ReadonlyArray<string> = ["owner_id", "user_id"];

const EMPTY_STATS: DashboardStats = Object.freeze({
  listingsPosted: 0,
  conceptsPosted: 0,
  validatedIdeas: 0,
  totalVotesReceived: 0,
});

/** Small helper: run a plain (non-embedded) select filtered by an owner column. */
async function selectOwnedRows<Row>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  ownerColumns: ReadonlyArray<string>,
  userId: string,
): Promise<{ readonly rows: ReadonlyArray<Row>; readonly error: string | null }> {
  let lastError: string | null = null;
  for (const col of ownerColumns) {
    try {
      const res = await sb.from(table).select(columns).eq(col, userId).order("created_at", { ascending: false }).limit(100);
      if (res.error === null) {
        return { rows: Array.isArray(res.data) ? (res.data as unknown as Row[]) : [], error: null };
      }
      lastError = res.error.message;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : "Query failed";
    }
  }
  return { rows: [], error: lastError ?? "Query failed" };
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
    // Query 1: the user's own listings (plain columns only).
    const listingsQ = await selectOwnedRows<ListingRow>(
      sb,
      "listings",
      "id, title, category, price_cents, image_url, created_at",
      LISTING_OWNER_COLUMNS,
      userId,
    );
    // Query 2: the user's own concepts (`select('*')` so we never reference a
    // column that might not exist on the live table).
    const conceptsQ = await selectOwnedRows<IdeaRow>(sb, "ideas", "*", IDEA_OWNER_COLUMNS, userId);

    if (listingsQ.error !== null && listingsQ.rows.length === 0) {
      return { ok: false, message: `Could not load your bizzes: ${listingsQ.error}` };
    }
    if (conceptsQ.error !== null && conceptsQ.rows.length === 0) {
      return { ok: false, message: `Could not load your concepts: ${conceptsQ.error}` };
    }

    const listingRows: ReadonlyArray<ListingRow> = listingsQ.rows;

    // Derive per-listing vote counts from the `votes` table instead of a
    // `listings.votes_count` column, which does not exist in our schema.
    // Runs best-effort: if the votes query fails we degrade to 0 rather than
    // breaking the whole dashboard.
    let votesByListing: Map<string, number> = new Map();
    if (listingRows.length > 0) {
      try {
        const votesRes = await sb
          .from("votes")
          .select("listing_id")
          .in("listing_id", listingRows.map((row: ListingRow): string => row.id))
          .limit(5000);
        if (votesRes.error === null && Array.isArray(votesRes.data)) {
          const counts = new Map<string, number>();
          for (const v of votesRes.data as Array<{ readonly listing_id?: string | null }>) {
            const lid: string | undefined = v.listing_id ?? undefined;
            if (typeof lid === "string" && lid.length > 0) {
              counts.set(lid, (counts.get(lid) ?? 0) + 1);
            }
          }
          votesByListing = counts;
        }
      } catch {
        // Best effort only — leave counts at zero.
      }
    }

    const listings: ReadonlyArray<DashboardListing> = Object.freeze(
      listingRows.map((row: ListingRow): DashboardListing => ({
        id: row.id,
        title: row.title ?? "Untitled bizz",
        category: normalizeFeedCategory(row.category),
        priceCents: typeof row.price_cents === "number" && Number.isFinite(row.price_cents) ? Math.max(0, Math.round(row.price_cents)) : 0,
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
