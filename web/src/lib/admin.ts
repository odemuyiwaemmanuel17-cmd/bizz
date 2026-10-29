import { getSupabase } from "./supabase";

export interface AdminOverview {
  readonly totalUsers: number;
  readonly newUsers: number;
  readonly totalCreators: number;
  readonly verifiedCreators: number;
  readonly publishedVideos: number;
  readonly totalListings: number;
  readonly activeListings: number;
  readonly totalIdeas: number;
  readonly validationVotes: number;
  readonly likes: number;
  readonly saves: number;
  readonly comments: number;
  readonly follows: number;
  readonly pendingVerification: number;
  readonly promotionRequests: number;
  readonly activePromotions: number;
  readonly paymentRecords: number;
  readonly confirmedPayments: number;
  readonly paymentEnvironment: string | null;
  readonly recentActivity: readonly AdminActivity[];
}

export interface AdminActivity { readonly kind: string; readonly label: string; readonly entityId: string; readonly createdAt: string; }
export interface AdminPage<T> { readonly rows: readonly T[]; readonly total: number; }
export interface AdminUser { readonly id: string; readonly displayName: string; readonly email: string | null; readonly username: string | null; readonly avatarUrl: string | null; readonly isVerified: boolean; readonly createdAt: string; }
export interface AdminVideo { readonly id: string; readonly userId: string; readonly creatorName: string; readonly username: string | null; readonly status: string; readonly caption: string | null; readonly videoUrl: string | null; readonly listingId: string | null; readonly createdAt: string; }
export interface AdminListing { readonly id: string; readonly userId: string; readonly ownerName: string; readonly title: string; readonly category: string; readonly status: string; readonly priceCents: number; readonly currency: string | null; readonly createdAt: string; }
export interface AdminIdea { readonly id: string; readonly userId: string; readonly ownerName: string; readonly title: string; readonly description: string; readonly category: string; readonly voteCount: number; readonly createdAt: string; }
export interface AdminReport { readonly reportType: "listing" | "comment"; readonly id: string; readonly targetId: string; readonly reporterId: string; readonly reporterName: string; readonly reason: string; readonly status: string; readonly createdAt: string; }
export interface AdminPromotionRequest { readonly id: string; readonly listingId: string; readonly listingTitle: string; readonly creatorId: string; readonly creatorName: string; readonly note: string; readonly status: string; readonly createdAt: string; }
export interface AdminAuditLog { readonly id: string; readonly administratorId: string; readonly administratorName: string; readonly action: string; readonly entityType: string; readonly entityId: string | null; readonly previousData: Record<string, unknown> | null; readonly newData: Record<string, unknown> | null; readonly reason: string | null; readonly createdAt: string; }

function requireSupabase() {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  return sb;
}

function numberValue(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function objectOrNull(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export async function getAdminOverview(): Promise<AdminOverview> {
  const result = await requireSupabase().rpc("admin_platform_overview");
  if (result.error) throw new Error(result.error.message);
  const row = (result.data ?? {}) as Record<string, unknown>;
  return {
    totalUsers: numberValue(row.totalUsers), newUsers: numberValue(row.newUsers), totalCreators: numberValue(row.totalCreators), verifiedCreators: numberValue(row.verifiedCreators),
    publishedVideos: numberValue(row.publishedVideos), totalListings: numberValue(row.totalListings), activeListings: numberValue(row.activeListings), totalIdeas: numberValue(row.totalIdeas),
    validationVotes: numberValue(row.validationVotes), likes: numberValue(row.likes), saves: numberValue(row.saves), comments: numberValue(row.comments), follows: numberValue(row.follows),
    pendingVerification: numberValue(row.pendingVerification), promotionRequests: numberValue(row.promotionRequests), activePromotions: numberValue(row.activePromotions),
    paymentRecords: numberValue(row.paymentRecords), confirmedPayments: numberValue(row.confirmedPayments), paymentEnvironment: stringOrNull(row.paymentEnvironment),
    recentActivity: (Array.isArray(row.recentActivity) ? row.recentActivity : []).flatMap((entry): AdminActivity[] => { if (entry === null || typeof entry !== "object") return []; const item = entry as Record<string, unknown>; if (typeof item.kind !== "string" || typeof item.label !== "string" || typeof item.entityId !== "string") return []; return [{ kind: item.kind, label: item.label, entityId: item.entityId, createdAt: String(item.createdAt ?? "") }]; }),
  };
}

async function callPage<T>(name: string, args: Record<string, unknown>, map: (row: Record<string, unknown>) => T): Promise<AdminPage<T>> {
  const result = await requireSupabase().rpc(name, args);
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<Record<string, unknown>>;
  return { rows: rows.map(map), total: numberValue(rows[0]?.total_count) };
}

export function adminPageArgs(search: string, status: string, page: number, pageSize = 25): Record<string, unknown> { return { p_search: search.trim() || null, p_status: status || null, p_page: page, p_page_size: pageSize }; }

export async function listAdminUsers(search: string, page: number): Promise<AdminPage<AdminUser>> { return callPage("admin_list_profiles", { p_search: search.trim() || null, p_page: page, p_page_size: 25 }, (row) => ({ id: String(row.id), displayName: String(row.display_name), email: stringOrNull(row.email), username: stringOrNull(row.username), avatarUrl: stringOrNull(row.avatar_url), isVerified: row.is_verified === true, createdAt: String(row.created_at) })); }
export async function listAdminVideos(search: string, status: string, page: number): Promise<AdminPage<AdminVideo>> { return callPage("admin_list_videos", adminPageArgs(search, status, page), (row) => ({ id: String(row.id), userId: String(row.user_id), creatorName: String(row.creator_name), username: stringOrNull(row.username), status: String(row.status), caption: stringOrNull(row.caption), videoUrl: stringOrNull(row.video_url), listingId: stringOrNull(row.listing_id), createdAt: String(row.created_at) })); }
export async function listAdminListings(search: string, status: string, page: number): Promise<AdminPage<AdminListing>> { return callPage("admin_list_listings", adminPageArgs(search, status, page), (row) => ({ id: String(row.id), userId: String(row.user_id), ownerName: String(row.owner_name), title: String(row.title), category: String(row.category), status: String(row.status), priceCents: numberValue(row.price_cents), currency: stringOrNull(row.currency), createdAt: String(row.created_at) })); }
export async function listAdminIdeas(search: string, status: string, page: number): Promise<AdminPage<AdminIdea>> { return callPage("admin_list_ideas", adminPageArgs(search, status, page), (row) => ({ id: String(row.id), userId: String(row.user_id), ownerName: String(row.owner_name), title: String(row.title), description: String(row.description ?? ""), category: String(row.category), voteCount: numberValue(row.vote_count), createdAt: String(row.created_at) })); }
export async function listAdminReports(status: string, page: number): Promise<AdminPage<AdminReport>> { return callPage("admin_list_reports", { p_status: status || null, p_page: page, p_page_size: 25 }, (row) => ({ reportType: String(row.report_type) as AdminReport["reportType"], id: String(row.id), targetId: String(row.target_id), reporterId: String(row.reporter_id), reporterName: String(row.reporter_name), reason: String(row.reason), status: String(row.status), createdAt: String(row.created_at) })); }
export async function listAdminPromotionRequests(status: string, page: number): Promise<AdminPage<AdminPromotionRequest>> { return callPage("admin_list_promotion_requests", { p_status: status || null, p_page: page, p_page_size: 25 }, (row) => ({ id: String(row.id), listingId: String(row.listing_id), listingTitle: String(row.listing_title), creatorId: String(row.creator_id), creatorName: String(row.creator_name), note: String(row.note), status: String(row.status), createdAt: String(row.created_at) })); }
export async function listAdminAuditLogs(page: number): Promise<AdminPage<AdminAuditLog>> { return callPage("admin_list_audit_logs", { p_page: page, p_page_size: 25 }, (row) => ({ id: String(row.id), administratorId: String(row.administrator_id), administratorName: String(row.administrator_name), action: String(row.action), entityType: String(row.entity_type), entityId: stringOrNull(row.entity_id), previousData: objectOrNull(row.previous_data), newData: objectOrNull(row.new_data), reason: stringOrNull(row.reason), createdAt: String(row.created_at) })); }

async function adminAction(name: string, args: Record<string, unknown>): Promise<void> { const result = await requireSupabase().rpc(name, args); if (result.error) throw new Error(result.error.message); }
export async function moderateVideo(id: string, action: "hide" | "restore", reason: string): Promise<void> { await adminAction("admin_moderate_video", { p_video_id: id, p_action: action, p_reason: reason || null }); }
export async function moderateListing(id: string, action: "archive" | "restore", reason: string): Promise<void> { await adminAction("admin_moderate_listing", { p_listing_id: id, p_action: action, p_reason: reason || null }); }
export async function updateAdminReport(type: string, id: string, status: string, reason: string): Promise<void> { await adminAction("admin_update_report", { p_report_type: type, p_report_id: id, p_status: status, p_reason: reason || null }); }
export async function updatePromotionRequest(id: string, status: string, reason: string): Promise<void> { await adminAction("admin_update_promotion_request", { p_request_id: id, p_status: status, p_reason: reason || null }); }
