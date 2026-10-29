import { getSupabase } from "./supabase";
import { creatorProfilePath } from "./creator";
import { priceCentsFromMajorValue, priceCentsFromValue, type FeedCategory } from "./feed";

export type MarketplaceSort = "relevance" | "newest" | "price_low" | "price_high";
export type ListingTypeFilter = "all" | "free" | "paid";

export interface MarketplaceSearchFilters {
  readonly query: string;
  readonly category: FeedCategory;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly listingType: ListingTypeFilter;
  readonly area: string;
  readonly sort: MarketplaceSort;
}

export interface MarketplaceBizzResult {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly priceCents: number | null;
  readonly currency: string;
  readonly isFree: boolean;
  readonly imageUrl: string | null;
  readonly creatorId: string;
  readonly creatorName: string;
  readonly creatorUsername: string | null;
  readonly createdAt: string;
}

export interface MarketplaceCreatorResult {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly area: string | null;
  readonly creatorType: string | null;
  readonly verified: boolean;
}

export interface MarketplaceVideoResult {
  readonly id: string;
  readonly videoUrl: string;
  readonly caption: string | null;
  readonly createdAt: string;
  readonly creatorId: string;
  readonly creatorName: string;
  readonly creatorUsername: string | null;
}

export interface MarketplaceSearchResult {
  readonly bizzes: ReadonlyArray<MarketplaceBizzResult>;
  readonly creators: ReadonlyArray<MarketplaceCreatorResult>;
  readonly videos: ReadonlyArray<MarketplaceVideoResult>;
  readonly error: string | null;
}

const EMPTY_RESULT: MarketplaceSearchResult = Object.freeze({ bizzes: [], creators: [], videos: [], error: null });

function safeTerm(value: string): string {
  return value.trim().replace(/[,%()]/g, " ").replace(/[*]/g, " ").replace(/\s+/g, " ").slice(0, 80);
}

function areaOf(row: { campus?: string | null; state?: string | null; country?: string | null }): string | null {
  return [row.campus, row.state, row.country].find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

function creatorName(row: { username?: string | null; display_name?: string | null }): string {
  return row.display_name?.trim() || row.username?.trim() || "Creator";
}

export async function searchMarketplace(filters: MarketplaceSearchFilters): Promise<MarketplaceSearchResult> {
  const sb = getSupabase();
  if (sb === null) return { ...EMPTY_RESULT, error: "Supabase is not configured." };
  const term = safeTerm(filters.query);
  const area = safeTerm(filters.area);
  const min = filters.minPrice.trim() === "" ? null : Number(filters.minPrice);
  const max = filters.maxPrice.trim() === "" ? null : Number(filters.maxPrice);
  const minCents = min !== null && Number.isFinite(min) && min >= 0 ? Math.round(min * 100) : null;
  const maxCents = max !== null && Number.isFinite(max) && max >= 0 ? Math.round(max * 100) : null;
  try {
    let areaQuery = sb.from("profiles").select("id,username,display_name,avatar_url,campus,state,country,creator_type,is_verified").limit(50);
    if (area.length > 0) areaQuery = areaQuery.or(`campus.ilike.%${area}%,state.ilike.%${area}%,country.ilike.%${area}%`);
    const areaResult = await areaQuery;
    if (areaResult.error) throw new Error(areaResult.error.message);
    const areaIds = (areaResult.data ?? []).map((row) => String((row as { id: string }).id));

    let creatorQuery = sb.from("profiles").select("id,username,display_name,avatar_url,campus,state,country,creator_type,is_verified").limit(20);
    if (term.length > 0) creatorQuery = creatorQuery.or(`username.ilike.%${term}%,display_name.ilike.%${term}%,bio.ilike.%${term}%,creator_type.ilike.%${term}%`);
    if (area.length > 0) creatorQuery = creatorQuery.or(`campus.ilike.%${area}%,state.ilike.%${area}%,country.ilike.%${area}%`);
    const creatorResult = await creatorQuery;
    if (creatorResult.error) throw new Error(creatorResult.error.message);
    const creatorRows = (creatorResult.data ?? []) as Array<{ id: string; username?: string | null; display_name?: string | null; avatar_url?: string | null; campus?: string | null; state?: string | null; country?: string | null; creator_type?: string | null; is_verified?: boolean | null }>;
    const creators = creatorRows.map((row) => ({ id: row.id, username: row.username ?? null, displayName: creatorName(row), avatarUrl: row.avatar_url ?? null, area: areaOf(row), creatorType: row.creator_type ?? null, verified: row.is_verified === true }));
    const creatorSearchIds = creatorRows.map((row) => row.id);

    const makeListingQuery = () => {
      let query = sb.from("listings").select("id,title,description,blurb,category,price_cents,price,currency,is_free,image_url,user_id,created_at,status").eq("status", "active").limit(40);
      if (filters.category !== "all") query = query.eq("category", filters.category);
      if (minCents !== null) query = query.gte("price_cents", minCents);
      if (maxCents !== null) query = query.lte("price_cents", maxCents);
      if (filters.listingType === "free") query = query.eq("is_free", true);
      if (filters.listingType === "paid") query = query.eq("is_free", false);
      if (area.length > 0 && areaIds.length > 0) query = query.in("user_id", areaIds);
      return query;
    };
    const listingRows = new Map<string, Record<string, unknown>>();
    const addListingRows = (data: unknown[] | null): void => { for (const row of data ?? []) { const item = row as Record<string, unknown>; if (typeof item.id === "string") listingRows.set(item.id, item); } };
    if (term.length > 0) {
      const result = await makeListingQuery().or(`title.ilike.%${term}%,description.ilike.%${term}%,blurb.ilike.%${term}%`);
      if (result.error) throw new Error(result.error.message);
      addListingRows(result.data as unknown[] | null);
    }
    if (term.length > 0 && creatorSearchIds.length > 0) {
      const result = await makeListingQuery().in("user_id", creatorSearchIds);
      if (result.error) throw new Error(result.error.message);
      addListingRows(result.data as unknown[] | null);
    }
    if (term.length === 0) {
      const result = await makeListingQuery();
      if (result.error) throw new Error(result.error.message);
      addListingRows(result.data as unknown[] | null);
    }
    const creatorById = new Map<string, typeof creators[number]>();
    for (const creator of creators) creatorById.set(creator.id, creator);
    const missingOwnerIds = Array.from(new Set(Array.from(listingRows.values()).map((row) => String(row.user_id ?? "")).filter((id) => id.length > 0 && !creatorById.has(id))));
    if (missingOwnerIds.length > 0) {
      const owners = await sb.from("profiles").select("id,username,display_name,avatar_url,campus,state,country,creator_type,is_verified").in("id", missingOwnerIds);
      if (owners.error) throw new Error(owners.error.message);
      for (const row of (owners.data ?? []) as typeof creatorRows) { const creator = { id: row.id, username: row.username ?? null, displayName: creatorName(row), avatarUrl: row.avatar_url ?? null, area: areaOf(row), creatorType: row.creator_type ?? null, verified: row.is_verified === true }; creatorById.set(row.id, creator); }
    }
    let bizzes = Array.from(listingRows.values()).filter((row) => {
      const ownerId = String(row.user_id ?? "");
      if (area.length > 0 && !areaIds.includes(ownerId)) return false;
      const isFree = row.is_free === true;
      if (filters.listingType === "free" && !isFree) return false;
      if (filters.listingType === "paid" && isFree) return false;
      return true;
    }).map((row) => { const ownerId = String(row.user_id ?? ""); const creator = creatorById.get(ownerId); const priceCents = priceCentsFromValue(row.price_cents) ?? priceCentsFromMajorValue(row.price); return { id: String(row.id), title: String(row.title ?? "Untitled Bizz"), description: String(row.description ?? row.blurb ?? ""), category: String(row.category ?? ""), priceCents, currency: typeof row.currency === "string" ? row.currency : "USD", isFree: row.is_free === true, imageUrl: typeof row.image_url === "string" ? row.image_url : null, creatorId: ownerId, creatorName: creator?.displayName ?? "Creator", creatorUsername: creator?.username ?? null, createdAt: String(row.created_at ?? "") }; });
    bizzes = bizzes.sort((a, b) => filters.sort === "price_low" ? (a.priceCents ?? Number.MAX_SAFE_INTEGER) - (b.priceCents ?? Number.MAX_SAFE_INTEGER) : filters.sort === "price_high" ? (b.priceCents ?? -1) - (a.priceCents ?? -1) : Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);

    const makeVideoQuery = () => {
      let query = sb.from("creator_videos").select("id,user_id,video_url,caption,created_at").eq("status", "published").not("video_url", "is", null).limit(20);
      if (area.length > 0 && areaIds.length > 0) query = query.in("user_id", areaIds);
      return query;
    };
    const videoRows = new Map<string, Record<string, unknown>>();
    const addVideoRows = (data: unknown[] | null): void => { for (const row of data ?? []) { const item = row as Record<string, unknown>; if (typeof item.id === "string") videoRows.set(item.id, item); } };
    if (term.length > 0) {
      const result = await makeVideoQuery().ilike("caption", `%${term}%`);
      if (result.error) throw new Error(result.error.message);
      addVideoRows(result.data as unknown[] | null);
    }
    if (term.length === 0) {
      const result = await makeVideoQuery();
      if (result.error) throw new Error(result.error.message);
      addVideoRows(result.data as unknown[] | null);
    }
    if (term.length > 0 && creatorSearchIds.length > 0) {
      const result = await makeVideoQuery().in("user_id", creatorSearchIds);
      if (result.error) throw new Error(result.error.message);
      addVideoRows(result.data as unknown[] | null);
    }
    const videos = Array.from(videoRows.values()).filter((row) => area.length === 0 || areaIds.includes(String(row.user_id ?? ""))).map((row) => { const creator = creatorById.get(String(row.user_id ?? "")); return { id: String(row.id), videoUrl: String(row.video_url), caption: typeof row.caption === "string" ? row.caption : null, createdAt: String(row.created_at ?? ""), creatorId: String(row.user_id ?? ""), creatorName: creator?.displayName ?? "Creator", creatorUsername: creator?.username ?? null }; }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
    return { bizzes, creators: creators.slice(0, 20), videos, error: null };
  } catch (error) {
    return { ...EMPTY_RESULT, error: error instanceof Error ? error.message : "Search could not be completed." };
  }
}

export function marketplaceProfileHref(result: MarketplaceCreatorResult): string {
  return creatorProfilePath(result.username, result.id);
}
