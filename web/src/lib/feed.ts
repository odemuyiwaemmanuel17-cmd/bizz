/**
 * Phase 3 — Marketplace feed data layer.
 *
 * Fetches active listings from Supabase (`public.listings` joined with the
 * creator's `public.profiles`) and exposes them as typed Hustle Cards data.
 * When Supabase env vars are missing (offline demo mode) it falls back to a
 * deterministic seed dataset so the feed is always browsable.
 *
 * All functions are total: network/DB failures resolve to an empty page with
 * a human-readable `error` string instead of throwing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import type { ContactChannel } from "./contact";

/* ------------------------------------------------------------------ */
/* Feed view model                                                     */
/* ------------------------------------------------------------------ */

export const FEED_CATEGORIES = ["all", "services", "tech", "campus", "digital"] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

export interface CategoryTab {
  readonly id: FeedCategory;
  readonly label: string;
}

export const CATEGORY_TABS: ReadonlyArray<CategoryTab> = Object.freeze([
  { id: "all", label: "All" },
  { id: "services", label: "Services" },
  { id: "tech", label: "Tech" },
  { id: "campus", label: "Campus" },
  { id: "digital", label: "Digital" },
]);

/** Maps the legacy schema.sql CHECK values onto the five feed tabs. */
const SCHEMA_CATEGORY_ALIASES: Readonly<Record<string, FeedCategory>> = Object.freeze({
  services: "services",
  tech: "tech",
  campus: "campus",
  digital: "digital",
  "digital-goods": "digital",
  content: "digital",
  saas: "tech",
  physical: "services",
});

export function normalizeFeedCategory(raw: string | null | undefined): FeedCategory {
  if (typeof raw !== "string") return "digital";
  const mapped: FeedCategory | undefined = SCHEMA_CATEGORY_ALIASES[raw.trim().toLowerCase()];
  return mapped ?? "digital";
}

export interface CreatorInfo {
  readonly id: string;
  readonly displayName: string;
  /** Avatar URL or null — cards render initials in that case. */
  readonly avatarUrl: string | null;
}

export interface HustleCardData {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly category: FeedCategory;
  /** Integer minor units (cents); use `formatPrice` for display. */
  readonly priceCents: number;
  readonly currency: string;
  readonly votesCount: number;
  readonly createdAt: string; // ISO timestamp
  readonly creator: CreatorInfo;
  readonly contactChannel: ContactChannel;
  readonly contactHandle: string;
}

export interface FeedPage {
  readonly items: ReadonlyArray<HustleCardData>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly error: string | null;
}

export interface FeedQuery {
  readonly category?: FeedCategory;
  readonly page?: number;
  readonly pageSize?: number;
  /** Case-insensitive substring match on title/blurb (client-side). */
  readonly search?: string;
}

/** Pure helper: filter cards by a search term across title, blurb and creator name. */
export function filterCardsBySearch(
  cards: ReadonlyArray<HustleCardData>,
  search: string,
): ReadonlyArray<HustleCardData> {
  const needle: string = search.trim().toLowerCase();
  if (needle.length === 0) return cards;
  return cards.filter(
    (card: HustleCardData): boolean =>
      card.title.toLowerCase().includes(needle) ||
      card.blurb.toLowerCase().includes(needle) ||
      card.creator.displayName.toLowerCase().includes(needle),
  );
}

export const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

/* ------------------------------------------------------------------ */
/* Price formatting                                                    */
/* ------------------------------------------------------------------ */

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
});

/** Formats integer cents into a compact price tag ("$12", "$12.50", "Free"). */
export function formatPrice(priceCents: number, currency: string = "USD"): string {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return "Free";
  const symbol: string = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const rupees: number = Math.round(priceCents) / 100;
  const fractionDigits: number = Number.isInteger(rupees) ? 0 : 2;
  return `${symbol}${rupees.toFixed(fractionDigits)}`;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface ProfileLite {
  readonly id: string;
  readonly handle?: string | null;
  readonly display_name?: string | null;
  readonly full_name?: string | null;
  readonly email?: string | null;
  readonly avatar_url?: string | null;
  readonly contact_channel?: string | null;
  readonly contact_handle?: string | null;
}

/** Raw shape returned by the plain listings select (profile hydrated separately). */
interface ListingRow {
  readonly id: string;
  readonly title: string | null;
  /** Live schema column is `description`; older dumps used `blurb`. */
  readonly description?: string | null;
  readonly blurb?: string | null;
  readonly category: string | null;
  readonly price_cents: number | null;
  readonly created_at: string | null;
  readonly user_id?: string | null;
  readonly profiles?: ProfileLite | null;
  readonly votes_count?: number | null;
}

function toContactChannel(raw: string | null | undefined): ContactChannel {
  return raw === "telegram" ? "telegram" : "whatsapp";
}

function pitchOf(row: ListingRow): string {
  if (typeof row.description === "string") return row.description;
  if (typeof row.blurb === "string") return row.blurb;
  return "";
}

function rowToCard(row: ListingRow): HustleCardData | null {
  const title: string = typeof row.title === "string" ? row.title.trim() : "";
  if (title.length === 0) return null; // defensive: skip malformed rows
  const profile = row.profiles ?? null;
  const creator: CreatorInfo = Object.freeze({
    id: profile?.id ?? row.user_id ?? "unknown",
    displayName:
      profile?.display_name ?? profile?.full_name ?? profile?.handle
      ?? (typeof profile?.email === "string" && profile.email.length > 0 ? profile.email.split("@")[0] ?? "Hustler" : "Hustler"),
    avatarUrl: profile?.avatar_url ?? null,
  });
  return Object.freeze({
    id: row.id,
    title,
    blurb: pitchOf(row),
    category: normalizeFeedCategory(row.category),
    priceCents: typeof row.price_cents === "number" && Number.isFinite(row.price_cents) ? Math.max(0, Math.round(row.price_cents)) : 0,
    currency: "USD",
    votesCount: typeof row.votes_count === "number" ? Math.max(0, row.votes_count) : 0,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date(0).toISOString(),
    creator,
    contactChannel: toContactChannel(profile?.contact_channel),
    contactHandle: profile?.contact_handle ?? "",
  });
}

/* ------------------------------------------------------------------ */
/* Seed data (offline demo mode)                                       */
/* ------------------------------------------------------------------ */

function seedCards(): ReadonlyArray<HustleCardData> {
  const day = 86_400_000;
  const now: number = Date.UTC(2026, 9, 1);
  const make = (
    index: number,
    title: string,
    blurb: string,
    category: FeedCategory,
    priceCents: number,
    votesCount: number,
    _handle: string, // creator slug kept for readability of the seed rows
    displayName: string,
    contactChannel: ContactChannel,
    contactHandle: string,
  ): HustleCardData =>
    Object.freeze({
      id: `seed-${index}`,
      title,
      blurb,
      category,
      priceCents,
      currency: "USD",
      votesCount,
      createdAt: new Date(now - index * day).toISOString(),
      creator: Object.freeze({ id: `seed-creator-${index % 4}`, displayName, avatarUrl: null }),
      contactChannel,
      contactHandle,
    });

  return Object.freeze([
    make(1, "Resume Roast", "Brutally honest resume feedback in 24h from recruiters.", "services", 1500, 42, "priya", "Priya S.", "whatsapp", "+15551234567"),
    make(2, "Notion OS for Students", "A plug-and-play Notion workspace that runs your whole semester.", "digital", 900, 128, "notionknight", "Notion Knight", "telegram", "@notionknight"),
    make(3, "PC Build Clinic", "Remote diagnostics + part picks tuned to your budget.", "tech", 3000, 76, "maxbuilds", "Max Builds", "whatsapp", "+15559876543"),
    make(4, "Campus Print Runner", "Dorm-to-library print delivery before 9am lectures.", "campus", 200, 210, "printduh", "Print Duh", "whatsapp", "+15550001111"),
    make(5, "Thesis Data Viz", "Publication-grade charts for your thesis chapter.", "tech", 4500, 33, "vizlab", "Viz Lab", "telegram", "@vizlabstudio"),
    make(6, "Fridge Meal Prep", "Weekly micro-batch meal prep priced per dorm room.", "campus", 2500, 89, "mealprep", "MealPrep Mike", "whatsapp", "+15552223344"),
    make(7, "Logo Sprint", "Three logo concepts in 48 hours, two revision rounds.", "digital", 8000, 54, "pixelmark", "Pixel & Mark", "telegram", "@pixelmarkco"),
    make(8, "Interview Buddy", "Mock interviews with ex-FAANG engineers, recorded.", "services", 6000, 145, "buddy", "Interview Buddy", "whatsapp", "+15554445566"),
    make(9, "Laptop ER", "Same-day software rescue for panicked finals-week laptops.", "tech", 2000, 61, "lapter", "Laptop ER", "whatsapp", "+15557778899"),
    make(10, "Club Promo Pack", "Posters, reels and story templates for your campus club.", "campus", 1200, 27, "promopack", "Promo Pack", "telegram", "@promopack"),
    make(11, "Spreadsheet Surgeon", "I fix your cursed Excel/Sheets model, no judgment.", "services", 3500, 98, "sheets", "Sheet Surgeon", "whatsapp", "+15556667788"),
    make(12, "Zine Printing Co-op", "Risograph-style zines printed and folded by students.", "digital", 1800, 40, "zinecoop", "Zine Co-op", "telegram", "@zinecoop"),
    make(13, "API Guardrails", "Type-safe client SDK generated from your OpenAPI spec.", "tech", 12000, 71, "apiguard", "API Guardrails", "whatsapp", "+15553332222"),
    make(14, "Roommate Matching", "Curated roommate intros with a 10-question compatibility quiz.", "campus", 500, 187, "roomie", "Roomie Radar", "telegram", "@roomieradar"),
    make(15, "Podcast Edit Kit", "Episodes cut, denoised and captioned within 72h.", "services", 5000, 36, "waveform", "Waveform Studio", "whatsapp", "+15551112233"),
  ]);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * One page of active hustle cards, newest first, optionally filtered by tab.
 * Never rejects — failures surface via `FeedPage.error`.
 */
export async function fetchHustleFeed(query: FeedQuery = {}): Promise<FeedPage> {
  const category: FeedCategory = query.category ?? "all";
  const page: number = Math.max(1, Math.trunc(query.page ?? 1));
  const requested: number = Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize: number = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_PAGE_SIZE));

  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    // Offline demo mode: filter + paginate the seed set locally.
    const all: ReadonlyArray<HustleCardData> = seedCards();
    const filtered: ReadonlyArray<HustleCardData> =
      category === "all" ? all : all.filter((card: HustleCardData) => card.category === category);
    const start: number = (page - 1) * pageSize;
    return Object.freeze({
      items: Object.freeze(filtered.slice(start, start + pageSize)),
      total: filtered.length,
      page,
      pageSize,
      error: null,
    });
  }

  try {
    /*
     * Robust fetch strategy (fixes "published but not rendering"):
     *  1. Plain `select("*")` — never embedded joins (`profiles(...)`) or
     *     aggregate aliases (`votes:count`), which throw schema-relationship
     *     errors when FK metadata is missing and abort the whole page load.
     *  2. NO `.eq("status","active")` filter on the first attempt — rows whose
     *     status column is NULL/missing would be silently excluded. If that
     *     returns zero rows we retry WITH the active filter (canonical path).
     *  3. Creator info is hydrated afterwards from `profiles` via a separate
     *     plain query (best-effort; failures degrade to defaults, never hide
     *     listings).
     */
    const rangeFrom: number = (page - 1) * pageSize;
    const runQuery = async (withStatusFilter: boolean): Promise<{ readonly rows: ReadonlyArray<ListingRow>; readonly count: number | null; readonly error: string | null }> => {
      try {
        let builder = sb.from("listings").select("*", { count: "exact" });
        if (withStatusFilter) builder = builder.eq("status", "active");
        const schemaValues: string[] =
          category === "all"
            ? []
            : Object.keys(SCHEMA_CATEGORY_ALIASES).filter((key: string) => SCHEMA_CATEGORY_ALIASES[key] === category);
        if (schemaValues.length > 0) builder = builder.in("category", schemaValues);
        const { data, count, error } = await builder
          .order("created_at", { ascending: false })
          .range(rangeFrom, rangeFrom + pageSize - 1);
        if (error !== null) return { rows: [], count: null, error: error.message };
        return { rows: Array.isArray(data) ? (data as unknown as ListingRow[]) : [], count, error: null };
      } catch (err: unknown) {
        return { rows: [], count: null, error: err instanceof Error ? err.message : "Query failed" };
      }
    };

    // Primary attempt WITHOUT the status filter (so NULL/missing statuses can't
    // hide rows); retry WITH `.eq("status","active")` only if it errored or
    // returned nothing while archived/draft rows might exist.
    let result = await runQuery(false);
    if (result.error !== null || result.rows.length === 0) {
      const filtered = await runQuery(true);
      if (result.error !== null && filtered.error === null) {
        result = filtered;
      } else if (result.rows.length === 0 && filtered.rows.length > 0) {
        result = filtered;
      }
    }
    if (result.error !== null) {
      // Last resort: minimal unfiltered fetch so at least something renders.
      try {
        const fallback = await sb.from("listings").select("*").range(rangeFrom, rangeFrom + pageSize - 1);
        if (fallback.error === null && Array.isArray(fallback.data)) {
          result = { rows: fallback.data as unknown as ListingRow[], count: null, error: null };
        }
      } catch {
        /* keep original error below */
      }
      if (result.error !== null) {
        return Object.freeze({ items: Object.freeze([]), total: 0, page, pageSize, error: result.error });
      }
    }

    // Hydrate creator info from profiles with a SEPARATE plain query.
    // Ownership source of truth is `user_id` ONLY (2nd-pass audit: legacy
    // owner_id fallback removed — live rows store the creator there and RLS
    // checks auth.uid() = user_id).
    const ownerIds: string[] = Array.from(
      new Set(result.rows.map((row: ListingRow): string => row.user_id ?? "").filter((id: string): boolean => id.length > 0)),
    );
    if (ownerIds.length > 0) {
      try {
        const profRes = await sb.from("profiles").select("*").in("id", ownerIds).limit(100);
        if (profRes.error === null && Array.isArray(profRes.data)) {
          const byId = new Map<string, ProfileLite>();
          for (const p of profRes.data as ReadonlyArray<ProfileLite>) {
            if (typeof p.id === "string") byId.set(p.id, p);
          }
          result = {
            ...result,
            rows: result.rows.map((row: ListingRow): ListingRow => ({
              ...row,
              profiles: byId.get(row.user_id ?? "") ?? null,
            })),
          };
        }
      } catch {
        /* decorative only — cards fall back to "Hustler" */
      }
    }

    const rows: ReadonlyArray<ListingRow> = result.rows;
    const cards: HustleCardData[] = [];
    for (const row of rows) {
      const card: HustleCardData | null = rowToCard(row);
      if (card !== null) cards.push(card);
    }
    return Object.freeze({
      items: Object.freeze(cards),
      total: typeof result.count === "number" ? result.count : cards.length,
      page,
      pageSize,
      error: null,
    });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Unknown feed error";
    return Object.freeze({ items: Object.freeze([]), total: 0, page, pageSize, error: message });
  }
}

/**
 * Vote counts for a batch of listing ids. AUDIT: the legacy `votes` table was
 * standardized onto idea voting (columns: id, idea_id, user_id, vote_type)
 * and no longer carries `listing_id`, so marketplace listings have NO real
 * vote source yet. We deliberately return an empty map (honest zeros) instead
 * of querying a table that would error or faking listing votes with idea
 * infrastructure. Wire this back once a proper marketplace-votes schema
 * exists.
 */
export async function voteCountsFor(_ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, number>> {
  return new Map<string, number>();
}

/** Attach live vote tallies to already-fetched cards (best effort). */
export async function hydrateVotes(items: ReadonlyArray<HustleCardData>): Promise<ReadonlyArray<HustleCardData>> {
  const counts: ReadonlyMap<string, number> = await voteCountsFor(items.map((item: HustleCardData) => item.id));
  return Object.freeze(
    items.map((item: HustleCardData): HustleCardData => {
      const count: number | undefined = counts.get(item.id);
      return count === undefined ? item : Object.freeze({ ...item, votesCount: count });
    }),
  );
}

