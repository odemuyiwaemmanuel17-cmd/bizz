import { getSupabase } from "./supabase";

export interface PromotionRequest {
  readonly id: string;
  readonly listingId: string;
  readonly listingTitle: string;
  readonly note: string;
  readonly status: "pending" | "approved" | "rejected" | "cancelled";
  readonly createdAt: string;
}

export async function currentUserId(): Promise<string> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const result = await sb.auth.getUser();
  if (result.error || result.data.user === null) throw new Error("Sign in to continue.");
  return result.data.user.id;
}

export async function reportListing(listingId: string, reason: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const reporterId = await currentUserId();
  const text = reason.trim();
  if (text.length < 1 || text.length > 500) throw new Error("Report reason must be between 1 and 500 characters.");
  const result = await sb.from("listing_reports").insert({ listing_id: listingId, reporter_id: reporterId, reason: text });
  if (result.error) throw new Error(result.error.message);
}

export async function listPromotionRequests(): Promise<PromotionRequest[]> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const creatorId = await currentUserId();
  const result = await sb.from("promotion_requests").select("id,listing_id,note,status,created_at").eq("creator_id", creatorId).order("created_at", { ascending: false });
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<{ id: string; listing_id: string; note: string; status: PromotionRequest["status"]; created_at: string }>;
  const listingIds = Array.from(new Set(rows.map((row) => row.listing_id)));
  const listingResult = listingIds.length === 0 ? { data: [], error: null } : await sb.from("listings").select("id,title").in("id", listingIds);
  if (listingResult.error) throw new Error(listingResult.error.message);
  const titles = new Map<string, string>();
  for (const row of (listingResult.data ?? []) as Array<{ id: string; title: string }>) titles.set(row.id, row.title);
  return rows.map((item) => ({ id: item.id, listingId: item.listing_id, listingTitle: titles.get(item.listing_id) ?? "Bizz", note: item.note, status: item.status, createdAt: item.created_at }));
}

export async function submitPromotionRequest(listingId: string, note: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const creatorId = await currentUserId();
  const text = note.trim();
  if (text.length < 10 || text.length > 1000) throw new Error("Promotion note must be between 10 and 1,000 characters.");
  const result = await sb.from("promotion_requests").insert({ listing_id: listingId, creator_id: creatorId, note: text, status: "pending" });
  if (result.error) throw new Error(result.error.message);
}
