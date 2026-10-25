import { getSupabase } from "./supabase";

export type AnalyticsEventName =
  | "video_view"
  | "video_like"
  | "video_save"
  | "profile_view"
  | "bizz_view"
  | "video_to_bizz_click"
  | "contact_click";

export type AnalyticsRange = 7 | 30 | 90 | "all";

export interface AnalyticsEventInput {
  readonly event: AnalyticsEventName;
  readonly videoId?: string;
  readonly listingId?: string;
  readonly profileId?: string;
  /** Entity-specific stable value used for the client session/time-window dedupe key. */
  readonly dedupeId?: string;
}

export interface AnalyticsTotals {
  readonly videoViews: number;
  readonly profileVisits: number;
  readonly bizzViews: number;
  readonly videoToBizzClicks: number;
  readonly contactClicks: number;
  readonly likes: number;
  readonly saves: number;
}

export interface AnalyticsTrend {
  readonly date: string;
  readonly videoViews: number;
  readonly profileVisits: number;
  readonly bizzViews: number;
  readonly videoToBizzClicks: number;
  readonly contactClicks: number;
}

export interface TopVideoAnalytics {
  readonly id: string;
  readonly title: string;
  readonly videoUrl: string | null;
  readonly views: number;
  readonly likes: number;
  readonly saves: number;
  readonly bizzClicks: number;
}

export interface TopBizzAnalytics {
  readonly id: string;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly views: number;
  readonly videoClicks: number;
  readonly contactClicks: number;
}

export interface CreatorAnalytics {
  readonly totals: AnalyticsTotals;
  readonly trends: ReadonlyArray<AnalyticsTrend>;
  readonly topVideos: ReadonlyArray<TopVideoAnalytics>;
  readonly topBizzes: ReadonlyArray<TopBizzAnalytics>;
}

export type AnalyticsResult =
  | { readonly ok: true; readonly data: CreatorAnalytics }
  | { readonly ok: false; readonly message: string };

const EMPTY_TOTALS: AnalyticsTotals = Object.freeze({
  videoViews: 0,
  profileVisits: 0,
  bizzViews: 0,
  videoToBizzClicks: 0,
  contactClicks: 0,
  likes: 0,
  saves: 0,
});

const EMPTY_ANALYTICS: CreatorAnalytics = Object.freeze({
  totals: EMPTY_TOTALS,
  trends: Object.freeze([]),
  topVideos: Object.freeze([]),
  topBizzes: Object.freeze([]),
});

let fallbackSessionId: string | null = null;
const SESSION_KEY = "hustlehub.analytics.session";
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sessionId(): string {
  if (fallbackSessionId !== null) return fallbackSessionId;
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing !== null && existing.length > 0) {
      fallbackSessionId = existing;
      return existing;
    }
    const next = randomId();
    window.sessionStorage.setItem(SESSION_KEY, next);
    fallbackSessionId = next;
    return next;
  } catch {
    fallbackSessionId = randomId();
    return fallbackSessionId;
  }
}

function dedupeKey(event: AnalyticsEventName, entity: string): string {
  const bucket = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  return `${event}:${entity}:${sessionId()}:${bucket}`;
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAnalytics(value: unknown): CreatorAnalytics {
  if (typeof value !== "object" || value === null) return EMPTY_ANALYTICS;
  const raw = value as { totals?: unknown; trends?: unknown; topVideos?: unknown; topBizzes?: unknown };
  const totals = typeof raw.totals === "object" && raw.totals !== null ? raw.totals as Record<string, unknown> : {};
  const trends = Array.isArray(raw.trends) ? raw.trends : [];
  const topVideos = Array.isArray(raw.topVideos) ? raw.topVideos : [];
  const topBizzes = Array.isArray(raw.topBizzes) ? raw.topBizzes : [];
  return {
    totals: {
      videoViews: finiteInt(totals.videoViews),
      profileVisits: finiteInt(totals.profileVisits),
      bizzViews: finiteInt(totals.bizzViews),
      videoToBizzClicks: finiteInt(totals.videoToBizzClicks),
      contactClicks: finiteInt(totals.contactClicks),
      likes: finiteInt(totals.likes),
      saves: finiteInt(totals.saves),
    },
    trends: trends.flatMap((item): AnalyticsTrend[] => {
      if (typeof item !== "object" || item === null) return [];
      const row = item as Record<string, unknown>;
      const date = stringOrNull(row.date);
      return date === null ? [] : [{
        date,
        videoViews: finiteInt(row.videoViews),
        profileVisits: finiteInt(row.profileVisits),
        bizzViews: finiteInt(row.bizzViews),
        videoToBizzClicks: finiteInt(row.videoToBizzClicks),
        contactClicks: finiteInt(row.contactClicks),
      }];
    }),
    topVideos: topVideos.flatMap((item): TopVideoAnalytics[] => {
      if (typeof item !== "object" || item === null) return [];
      const row = item as Record<string, unknown>;
      const id = stringOrNull(row.id);
      return id === null ? [] : [{ id, title: stringOrNull(row.title) ?? "Published video", videoUrl: stringOrNull(row.videoUrl), views: finiteInt(row.views), likes: finiteInt(row.likes), saves: finiteInt(row.saves), bizzClicks: finiteInt(row.bizzClicks) }];
    }),
    topBizzes: topBizzes.flatMap((item): TopBizzAnalytics[] => {
      if (typeof item !== "object" || item === null) return [];
      const row = item as Record<string, unknown>;
      const id = stringOrNull(row.id);
      return id === null ? [] : [{ id, title: stringOrNull(row.title) ?? "Untitled Bizz", imageUrl: stringOrNull(row.imageUrl), views: finiteInt(row.views), videoClicks: finiteInt(row.videoClicks), contactClicks: finiteInt(row.contactClicks) }];
    }),
  };
}

/** Records an event through the protected Supabase RPC. Tracking failures never break the user flow. */
export async function trackAnalyticsEvent(input: AnalyticsEventInput): Promise<void> {
  try {
    const sb = getSupabase();
    if (sb === null) return;
    const entity = input.dedupeId ?? input.videoId ?? input.listingId ?? input.profileId;
    const result = await sb.rpc("record_analytics_event", {
      p_event_name: input.event,
      p_video_id: input.videoId ?? null,
      p_listing_id: input.listingId ?? null,
      p_profile_id: input.profileId ?? null,
      p_dedupe_key: entity === undefined ? null : dedupeKey(input.event, entity),
    });
    if (result.error !== null) {
      // Analytics is deliberately best-effort so a missing Phase 6 migration
      // cannot break video playback, contact, or navigation.
      console.warn("[analytics] event was not recorded:", result.error.message);
    }
  } catch (error) {
    console.warn("[analytics] event request failed:", error);
  }
}

export async function fetchCreatorAnalytics(userId: string, range: AnalyticsRange): Promise<AnalyticsResult> {
  const sb = getSupabase();
  if (sb === null) return { ok: true, data: EMPTY_ANALYTICS };
  const from = range === "all" ? null : new Date(Date.now() - range * 86_400_000).toISOString();
  const result = await sb.rpc("get_creator_analytics", { p_creator_id: userId, p_from: from });
  if (result.error !== null) return { ok: false, message: result.error.message };
  return { ok: true, data: parseAnalytics(result.data) };
}

export function engagementRate(totals: AnalyticsTotals): number {
  if (totals.videoViews <= 0) return 0;
  return ((totals.likes + totals.saves) / totals.videoViews) * 100;
}

export function bizzClickThroughRate(totals: AnalyticsTotals): number {
  if (totals.videoViews <= 0) return 0;
  return (totals.videoToBizzClicks / totals.videoViews) * 100;
}
