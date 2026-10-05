/**
 * Phase 4 — Creator flow ("Post a Bizz") + validation ideas ("Bizz or Fizz").
 *
 * Data layer for:
 *  - Multi-step listing drafts with per-step validation.
 *  - Supabase Storage image uploads (bucket `listing-images`) with an offline
 *    data-URL fallback so the demo works without credentials.
 *  - Publishing to `public.listings` (status 'active') for authenticated users.
 *  - Concept-phase "ideas" with bizz/fizz sentiment votes, live tallies and
 *    realtime subscriptions when Supabase is configured; deterministic
 *    weighted pseudo-random tallies in offline demo mode.
 *
 * Every exported function is total: failures resolve to typed error results
 * instead of throwing.
 */

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabase, getSessionSafe, ensureProfileRow, type AuthSnapshot } from "./supabase";
import { normalizeFeedCategory, type FeedCategory } from "./feed";
import { normalizeContactLink, CONTACT_LINK_PLACEHOLDER, type ContactChannel } from "./contact";

/* ------------------------------------------------------------------ */
/* Shared result helpers                                               */
/* ------------------------------------------------------------------ */

export interface UploadProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

export type FailureReason = "not-authenticated" | "storage" | "database" | "network" | "invalid";

export interface PublishFailure {
  readonly ok: false;
  readonly reason: FailureReason;
  readonly message: string;
}

export interface PublishSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type PublishResult<T> = PublishSuccess<T> | PublishFailure;

function fail(reason: FailureReason, message: string): PublishFailure {
  return Object.freeze({ ok: false as const, reason, message });
}

function succeed<T>(value: T): PublishSuccess<T> {
  return Object.freeze({ ok: true as const, value });
}

/* ------------------------------------------------------------------ */
/* Image assets                                                        */
/* ------------------------------------------------------------------ */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_IMAGE_TYPES: ReadonlyArray<string> = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface ValidatedImage {
  readonly file: File;
  readonly previewUrl: string;
}

export type ImageValidationResult =
  | { readonly ok: true; readonly value: ValidatedImage }
  | { readonly ok: false; readonly message: string };

/** Validates MIME type + size and produces an object-URL preview. */
export function validateAndPreviewImage(file: File | null | undefined): ImageValidationResult {
  if (file === null || file === undefined) {
    return { ok: false, message: "No file selected." };
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { ok: false, message: `Unsupported image type "${file.type || "unknown"}". Use PNG, JPG, WEBP or GIF.` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb: string = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `Image is ${mb} MB — the limit is 5 MB.` };
  }
  if (file.size === 0) {
    return { ok: false, message: "Image file appears to be empty." };
  }
  try {
    const previewUrl: string = URL.createObjectURL(file);
    return { ok: true, value: Object.freeze({ file, previewUrl }) };
  } catch {
    // Environments without URL.createObjectURL (SSR/tests): fall back to FileReader.
    return { ok: false, message: "This browser cannot preview the image, but upload may still work." };
  }
}

/** Revokes a preview URL created by validateAndPreviewImage (idempotent-safe). */
export function releaseImagePreview(previewUrl: string | null): void {
  if (previewUrl === null || previewUrl.length === 0) return;
  try {
    if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
  } catch {
    // Ignore revoke failures — nothing actionable.
  }
}

const IMAGE_BUCKET = "listing-images";

export type ImageUploadOutcome =
  | { readonly ok: true; readonly publicUrl: string }
  | { readonly ok: false; readonly message: string };

function buildStoragePath(userId: string, fileName: string): string {
  const safeName: string = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp: string = Date.now().toString(36);
  const rand: string = Math.random().toString(36).slice(2, 8);
  return `${userId}/${stamp}-${rand}-${safeName || "image"}`;
}

async function readAsDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve) => {
    try {
      const reader: FileReader = new FileReader();
      reader.onload = (): void => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = (): void => resolve("");
      reader.readAsDataURL(file);
    } catch {
      resolve("");
    }
  });
}

/**
 * Uploads the cover image. With Supabase configured it goes to the
 * `listing-images` public bucket; otherwise the file is inlined as a data URL
 * (offline demo mode). Reports progress via the callback when supported.
 */
export async function uploadListingImage(
  file: File,
  userId: string,
  onProgress?: ProgressCallback,
): Promise<ImageUploadOutcome> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    const dataUrl: string = await readAsDataUrl(file);
    if (dataUrl.length === 0) return { ok: false, message: "Could not read the image file." };
    onProgress?.({ loadedBytes: file.size, totalBytes: file.size });
    return { ok: true, publicUrl: dataUrl };
  }

  const path: string = buildStoragePath(userId, file.name);
  try {
    onProgress?.({ loadedBytes: 0, totalBytes: file.size });
    const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error !== null) {
      return { ok: false, message: `Storage upload failed: ${error.message}` };
    }
    onProgress?.({ loadedBytes: file.size, totalBytes: file.size });
    const { data } = sb.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    const publicUrl: string = data.publicUrl;
    return publicUrl.length > 0 ? { ok: true, publicUrl } : { ok: false, message: "Storage returned no public URL." };
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Unknown storage error";
    return { ok: false, message: `Storage upload failed: ${message}` };
  }
}

/* ------------------------------------------------------------------ */
/* Multi-step draft model + step validators                            */
/* ------------------------------------------------------------------ */

export interface ListingDraft {
  readonly title: string;
  readonly blurb: string;
  readonly category: FeedCategory;
  readonly priceCents: number;
  readonly currency: string;
  readonly imageUrl: string | null;
  readonly isConcept: boolean;
  /** Outreach channel used for the `contact_link` deep link. */
  readonly contactChannel: ContactChannel;
  /** Raw WhatsApp phone / Telegram username entered by the creator. */
  readonly contactHandle: string;
}

export const EMPTY_DRAFT: ListingDraft = Object.freeze({
  title: "",
  blurb: "",
  category: "services",
  priceCents: 0,
  currency: "USD",
  imageUrl: null,
  isConcept: false,
  contactChannel: "whatsapp",
  contactHandle: "",
});

export const FORM_STEPS = ["Basics", "Details", "Media", "Review"] as const;
export type FormStep = (typeof FORM_STEPS)[number];

export const STEP_FIELDS: Readonly<Record<FormStep, ReadonlyArray<keyof ListingDraft>>> = Object.freeze({
  Basics: ["title"],
  Details: ["blurb", "category", "priceCents", "contactHandle"],
  Media: [],
  Review: [],
});

export type DraftErrors = Partial<Record<keyof ListingDraft, string>>;

const TITLE_MIN = 3;
const TITLE_MAX = 80;
const BLURB_MAX = 280;

function validateTitle(title: string): string | null {
  const trimmed: string = title.trim();
  if (trimmed.length < TITLE_MIN) return `Title needs at least ${TITLE_MIN} characters.`;
  if (trimmed.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`;
  return null;
}

function validateBlurb(blurb: string, isConcept: boolean): string | null {
  const trimmed: string = blurb.trim();
  if (isConcept && trimmed.length === 0) return null; // concepts may skip the pitch
  if (trimmed.length < 10) return "Describe the hustle in at least 10 characters.";
  if (trimmed.length > BLURB_MAX) return `Keep it under ${BLURB_MAX} characters (${trimmed.length} now).`;
  return null;
}

function validatePrice(priceCents: number, isConcept: boolean): string | null {
  if (!Number.isFinite(priceCents)) return "Price must be a number.";
  if (priceCents < 0) return "Price cannot be negative.";
  if (priceCents > 10_000_00) return "Price is unrealistically high (max $10,000).";
  if (isConcept && priceCents === 0) return null;
  return null;
}

/** Errors for the fields belonging to a single wizard step. */
export function validateDraftStep(draft: ListingDraft, stepIndex: number): DraftErrors {
  const errors: DraftErrors = {};
  const index: number = Math.trunc(stepIndex);
  if (index === 0) {
    const titleError: string | null = validateTitle(draft.title);
    if (titleError !== null) errors.title = titleError;
  } else if (index === 1) {
    const blurbError: string | null = validateBlurb(draft.blurb, draft.isConcept);
    if (blurbError !== null) errors.blurb = blurbError;
    if (draft.category === "all") errors.category = "Pick a real category tab.";
    const priceError: string | null = validatePrice(draft.priceCents, draft.isConcept);
    if (priceError !== null) errors.priceCents = priceError;
    // Contact is optional, but when provided it must be a valid WhatsApp
    // phone or Telegram handle so we can store a usable deep link. Blank
    // input is allowed and falls back to a non-null placeholder on insert.
    if (draft.contactHandle.trim().length > 0 && normalizeContactLink(draft.contactChannel, draft.contactHandle) === null) {
      errors.contactHandle =
        draft.contactChannel === "whatsapp"
          ? "Enter a valid WhatsApp number with country code (e.g. +14155550123)."
          : "Enter a valid Telegram username (5–32 letters, digits or underscores).";
    }
  }
  return errors;
}

/** Whole-draft validation used before publishing. */
export function validateDraft(draft: ListingDraft): DraftErrors {
  return { ...validateDraftStep(draft, 0), ...validateDraftStep(draft, 1) };
}

export function isDraftValid(draft: ListingDraft): boolean {
  return Object.keys(validateDraft(draft)).length === 0;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface IdeaRow {
  readonly id: string;
  readonly owner_id: string | null;
  readonly title: string | null;
  readonly pitch: string | null;
  readonly category: string | null;
  readonly target_price_cents: number | null;
  readonly image_url: string | null;
  readonly status: string | null;
  readonly created_at: string | null;
  readonly bizz_count?: number | null;
  readonly fizz_count?: number | null;
  readonly profiles?: {
    readonly display_name: string | null;
    readonly handle: string | null;
  } | null;
}

export interface SentimentTally {
  readonly bizz: number;
  readonly fizz: number;
  readonly total: number;
  /** Percentage of believers, rounded to whole numbers summing to 100. */
  readonly bizzPercent: number;
  readonly fizzPercent: number;
}

export function computeTally(bizz: number, fizz: number): SentimentTally {
  const b: number = Math.max(0, Number.isFinite(bizz) ? Math.trunc(bizz) : 0);
  const f: number = Math.max(0, Number.isFinite(fizz) ? Math.trunc(fizz) : 0);
  const total: number = b + f;
  if (total === 0) return Object.freeze({ bizz: 0, fizz: 0, total: 0, bizzPercent: 0, fizzPercent: 0 });
  const bizzPercent: number = Math.round((b / total) * 100);
  return Object.freeze({
    bizz: b,
    fizz: f,
    total,
    bizzPercent,
    fizzPercent: 100 - bizzPercent, // guarantees the bars sum to exactly 100
  });
}

export interface ValidationIdea {
  readonly id: string;
  readonly title: string;
  readonly pitch: string;
  readonly category: FeedCategory;
  readonly targetPriceCents: number;
  readonly imageUrl: string | null;
  readonly createdAt: string;
  readonly ownerId: string;
  readonly creatorName: string;
  readonly tally: SentimentTally;
  /** True once believers cross the validation threshold. */
  readonly validated: boolean;
}

export const VALIDATION_THRESHOLD_BIZZ = 50;

export function isValidated(tally: SentimentTally): boolean {
  return tally.bizz >= VALIDATION_THRESHOLD_BIZZ && tally.bizzPercent >= 60;
}

function rowToIdea(row: IdeaRow): ValidationIdea | null {
  const title: string = typeof row.title === "string" ? row.title.trim() : "";
  if (title.length === 0) return null;
  const tally: SentimentTally = computeTally(row.bizz_count ?? 0, row.fizz_count ?? 0);
  return Object.freeze({
    id: row.id,
    title,
    pitch: typeof row.pitch === "string" ? row.pitch : "",
    category: normalizeFeedCategory(row.category),
    targetPriceCents: typeof row.target_price_cents === "number" && Number.isFinite(row.target_price_cents)
      ? Math.max(0, Math.round(row.target_price_cents))
      : 0,
    imageUrl: typeof row.image_url === "string" ? row.image_url : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date(0).toISOString(),
    ownerId: row.owner_id ?? "unknown",
    creatorName: row.profiles?.display_name ?? row.profiles?.handle ?? "Anonymous hustler",
    tally,
    validated: isValidated(tally),
  });
}

/* ------------------------------------------------------------------ */
/* Ideas CRUD + voting                                                 */
/* ------------------------------------------------------------------ */

export interface IdeaPage {
  readonly items: ReadonlyArray<ValidationIdea>;
  readonly error: string | null;
}

export type VoteChoice = "bizz" | "fizz";

export interface VoteOutcome {
  readonly ok: boolean;
  readonly tally: SentimentTally;
  readonly myVote: VoteChoice | null;
  readonly error: string | null;
}

/* ---- Offline demo mode (deterministic pseudo-random tallies) ---- */

function hashString(input: string): number {
  let h: number = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a: number = seed >>> 0;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t: number = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface OfflineIdeaState {
  bizz: number;
  fizz: number;
  myVote: VoteChoice | null;
}

const offlineIdeas: Map<string, OfflineIdeaState> = new Map<string, OfflineIdeaState>();

function offlineSeedFor(id: string): OfflineIdeaState {
  const existing: OfflineIdeaState | undefined = offlineIdeas.get(id);
  if (existing !== undefined) return existing;
  const rand: () => number = mulberry32(hashString(id));
  const total: number = 8 + Math.floor(rand() * 90); // 8..97 voters
  const bias: number = rand(); // sentiment skew
  const bizz: number = Math.round(total * (bias < 0.35 ? 0.15 + rand() * 0.2 : 0.55 + rand() * 0.35));
  const state: OfflineIdeaState = { bizz: Math.min(total, bizz), fizz: Math.max(0, total - bizz), myVote: null };
  offlineIdeas.set(id, state);
  return state;
}

const OFFLINE_IDEAS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly pitch: string; readonly category: FeedCategory; readonly price: number; readonly creator: string }> = Object.freeze([
  { id: "idea-protein", title: "Protein Vending Wall", pitch: "Refillable protein shake vending machine in the gym basement, split profits with the club.", category: "campus", price: 400, creator: "Gym Rat Gabe" },
  { id: "idea-syllabus", title: "Syllabus-to-Notion Bot", pitch: "Paste a PDF syllabus, get a full Notion semester workspace with deadlines auto-imported.", category: "digital", price: 700, creator: "Notion Knight" },
  { id: "idea-laundry", title: "Laundry Slot Swapper", pitch: "Marketplace for trading dorm laundry slots — sell your 2am slot, buy the 6pm one.", category: "campus", price: 100, creator: "Sudsy Sam" },
  { id: "idea-mocktail", title: "Micro-Batch Mocktails", pitch: "Zero-proof cocktail kits delivered to study groups during finals week.", category: "services", price: 1500, creator: "Pour Decisions" },
  { id: "idea-codeaudit", title: "5-Minute Portfolio Audit", pitch: "Automated Lighthouse + a11y audit of student portfolio sites with a fixes checklist.", category: "tech", price: 900, creator: "Audit Andy" },
]);

function offlineIdeaPage(): IdeaPage {
  const items: ValidationIdea[] = OFFLINE_IDEAS.map((seed, index) => {
    const state: OfflineIdeaState = offlineSeedFor(seed.id);
    const tally: SentimentTally = computeTally(state.bizz, state.fizz);
    return Object.freeze({
      id: seed.id,
      title: seed.title,
      pitch: seed.pitch,
      category: seed.category,
      targetPriceCents: seed.price,
      imageUrl: null,
      createdAt: new Date(Date.UTC(2026, 9, 1) - index * 86_400_000).toISOString(),
      ownerId: `offline-${index}`,
      creatorName: seed.creator,
      tally,
      validated: isValidated(tally),
    });
  });
  return Object.freeze({ items: Object.freeze(items), error: null });
}

/* ---- Supabase-backed queries ---- */

/** Fetches open validation ideas (newest first). Never rejects. */
export async function fetchIdeas(limit: number = 24): Promise<IdeaPage> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return offlineIdeaPage();
  const capped: number = Math.min(50, Math.max(1, Math.trunc(limit)));
  try {
    const { data, error } = await sb
      .from("ideas")
      .select("id, owner_id, title, pitch, category, target_price_cents, image_url, status, created_at, profiles:profiles(display_name, handle)")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(capped);
    if (error !== null) return Object.freeze({ items: Object.freeze([]), error: error.message });
    const rows: IdeaRow[] = Array.isArray(data) ? (data as unknown as IdeaRow[]) : [];
    const mapped: ReadonlyArray<ValidationIdea | null> = await Promise.all(
      rows.map(async (row: IdeaRow): Promise<ValidationIdea | null> => {
        const tally: SentimentTally = await tallyFromVotes(sb, row.id);
        const idea: ValidationIdea | null = rowToIdea({ ...row, bizz_count: tally.bizz, fizz_count: tally.fizz });
        return idea;
      }),
    );
    const items: ValidationIdea[] = mapped.filter((idea: ValidationIdea | null): idea is ValidationIdea => idea !== null);
    return Object.freeze({ items: Object.freeze(items), error: null });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Unknown ideas error";
    return Object.freeze({ items: Object.freeze([]), error: message });
  }
}

async function tallyFromVotes(sb: SupabaseClient, ideaId: string): Promise<SentimentTally> {
  try {
    const { data, error } = await sb.from("idea_votes").select("choice").eq("idea_id", ideaId);
    if (error !== null || !Array.isArray(data)) return computeTally(0, 0);
    let bizz: number = 0;
    let fizz: number = 0;
    for (const row of data as ReadonlyArray<{ readonly choice?: unknown }>) {
      if (row.choice === "bizz") bizz += 1;
      else if (row.choice === "fizz") fizz += 1;
    }
    return computeTally(bizz, fizz);
  } catch {
    return computeTally(0, 0);
  }
}

async function myVoteFor(sb: SupabaseClient, ideaId: string, userId: string): Promise<VoteChoice | null> {
  try {
    const { data, error } = await sb
      .from("idea_votes")
      .select("choice")
      .eq("idea_id", ideaId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error !== null || data === null || data === undefined) return null;
    const choice: unknown = (data as { readonly choice?: unknown }).choice;
    return choice === "bizz" || choice === "fizz" ? choice : null;
  } catch {
    return null;
  }
}

/**
 * Cast or switch the signed-in user's Bizz/Fizz vote. Re-voting the same side
 * toggles the vote off. Falls back to the offline ledger when unconfigured.
 */
export async function castIdeaVote(ideaId: string, choice: VoteChoice): Promise<VoteOutcome> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    const state: OfflineIdeaState = offlineSeedFor(ideaId);
    if (state.myVote === choice) {
      if (choice === "bizz") state.bizz = Math.max(0, state.bizz - 1);
      else state.fizz = Math.max(0, state.fizz - 1);
      state.myVote = null;
    } else {
      if (state.myVote === "bizz") state.bizz = Math.max(0, state.bizz - 1);
      if (state.myVote === "fizz") state.fizz = Math.max(0, state.fizz - 1);
      if (choice === "bizz") state.bizz += 1;
      else state.fizz += 1;
      state.myVote = choice;
    }
    return Object.freeze({
      ok: true,
      tally: computeTally(state.bizz, state.fizz),
      myVote: state.myVote,
      error: null,
    });
  }

  const snapshot: AuthSnapshot = await getSessionSafe();
  const userId: string | null = snapshot.user?.id ?? null;
  if (userId === null) {
    return Object.freeze({
      ok: false,
      tally: await tallyFromVotes(sb, ideaId),
      myVote: null,
      error: "Sign in to vote on ideas.",
    });
  }

  try {
    const previous: VoteChoice | null = await myVoteFor(sb, ideaId, userId);
    if (previous === choice) {
      const { error } = await sb.from("idea_votes").delete().eq("idea_id", ideaId).eq("user_id", userId);
      if (error !== null) {
        return Object.freeze({ ok: false, tally: await tallyFromVotes(sb, ideaId), myVote: previous, error: error.message });
      }
      return Object.freeze({ ok: true, tally: await tallyFromVotes(sb, ideaId), myVote: null, error: null });
    }
    if (previous !== null) {
      const { error } = await sb
        .from("idea_votes")
        .update({ choice })
        .eq("idea_id", ideaId)
        .eq("user_id", userId);
      if (error !== null) {
        return Object.freeze({ ok: false, tally: await tallyFromVotes(sb, ideaId), myVote: previous, error: error.message });
      }
    } else {
      const { error } = await sb.from("idea_votes").insert({ idea_id: ideaId, user_id: userId, choice });
      if (error !== null) {
        return Object.freeze({ ok: false, tally: await tallyFromVotes(sb, ideaId), myVote: null, error: error.message });
      }
    }
    return Object.freeze({ ok: true, tally: await tallyFromVotes(sb, ideaId), myVote: choice, error: null });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Vote failed";
    return Object.freeze({ ok: false, tally: computeTally(0, 0), myVote: null, error: message });
  }
}

/** Read-only view of a caller's current vote (for hydrating cards). */
export async function fetchMyIdeaVote(ideaId: string): Promise<VoteChoice | null> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return offlineSeedFor(ideaId).myVote;
  const snapshot: AuthSnapshot = await getSessionSafe();
  const userId: string | null = snapshot.user?.id ?? null;
  if (userId === null) return null;
  return await myVoteFor(sb, ideaId, userId);
}

/**
 * Subscribes to idea_votes changes for realtime tally bars. Returns an
 * unsubscribe function; fires the callback with fresh tallies on any change.
 * In offline mode returns a no-op subscription.
 */
export function subscribeToIdeaVotes(onChange: (ideaId: string) => void): () => void {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return () => undefined;
  try {
    const channel = sb
      .channel("idea-votes-stream")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "idea_votes" },
        (payload: { readonly new?: unknown; readonly old?: unknown }): void => {
          const row = (payload.new ?? payload.old) as { readonly idea_id?: unknown } | null;
          const ideaId: string = String(row?.idea_id ?? "");
          if (ideaId.length > 0) onChange(ideaId);
        },
      )
      .subscribe();
    return (): void => {
      void sb.removeChannel(channel);
    };
  } catch {
    return () => undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Publishing                                                          */
/* ------------------------------------------------------------------ */

export interface PublishedListing {
  readonly id: string;
  readonly title: string;
  readonly isConcept: boolean;
  readonly imageUrl: string | null;
}

interface InsertedRow {
  readonly id: string;
}

/**
 * Publishes the validated draft. Concepts go to `public.ideas` (Bizz/Fizz
 * validation pool); concrete offers go to `public.listings` as active rows.
 * Requires authentication when Supabase is configured; in offline demo mode
 * it mints a local id so the wizard flow can be exercised end-to-end.
 */
export async function publishListing(draft: ListingDraft): Promise<PublishResult<PublishedListing>> {
  const errors: DraftErrors = validateDraft(draft);
  if (Object.keys(errors).length > 0) {
    const first: string = Object.values(errors)[0] ?? "Invalid draft";
    return fail("invalid", first);
  }

  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    const id: string = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (draft.isConcept) offlineSeedFor(id);
    return succeed({ id, title: draft.title.trim(), isConcept: draft.isConcept, imageUrl: draft.imageUrl });
  }

  /*
   * Resolve the acting user with a SERVER-side verification.
   * `getSessionSafe()` reads the client's local storage token, which can be
   * stale/expired — inserting with that id then trips RLS policies such as
   * `with check (owner_id = auth.uid())`. `getUser()` hits the auth server,
   * refreshes the token, and returns the authoritative uid used by RLS.
   */
  let userId: string | null = null;
  try {
    const { data: userData, error: userError } = await sb.auth.getUser();
    if (userError !== null) throw userError;
    userId = userData.user?.id ?? null;
  } catch {
    // Fall back to the cached session snapshot if the network call fails.
    const snapshot: AuthSnapshot = await getSessionSafe();
    userId = snapshot.user?.id ?? null;
  }
  if (userId === null) return fail("not-authenticated", "Sign in before posting a bizz.");

  /*
   * Guarantee the profiles row exists BEFORE any insert: listings.owner_id
   * and ideas.owner_id carry FKs to public.profiles(id), so a missing row
   * surfaces as a confusing foreign key violation at publish time. The
   * upsert is best-effort (a DB trigger may have already created it).
   */
  try {
    const { data: profileCheck, error: profileError } = await sb
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (profileError === null && profileCheck === null) {
      const minimalUser: Pick<User, "id"> = { id: userId };
      await ensureProfileRow(minimalUser as User);
    }
  } catch (err: unknown) {
    console.warn("[publish] profile pre-check failed:", err);
  }

  try {
    if (draft.isConcept) {
      const { data, error } = await sb
        .from("ideas")
        .insert({
          // Explicitly set to the verified logged-in user id so the insert
          // satisfies the RLS policy: user_id = auth.uid(). The live
          // `ideas` table stores the creator in `user_id` and the pitch in
          // `description` (owner_id/pitch/target_price_cents are legacy
          // names that trip the PostgREST schema cache).
          user_id: userId,
          title: draft.title.trim(),
          description: draft.blurb.trim(),
          category: draft.category,
          price_cents: draft.priceCents,
          image_url: draft.imageUrl,
          status: "open",
        })
        .select("id")
        .single();
      if (error !== null) return fail("database", `Could not save the idea: ${error.message}`);
      const row: InsertedRow = data as unknown as InsertedRow;
      return succeed({ id: row.id, title: draft.title.trim(), isConcept: true, imageUrl: draft.imageUrl });
    }

    /*
     * Build the row payload. The live Supabase database may store the creator
     * id under either `owner_id` (original schema) or `user_id` (current
     * schema), and the price/contact columns have drifted too. Rather than
     * hard-coding one shape, we try compatible payloads in order until the
     * insert passes both the PostgREST schema cache and the RLS check
     * (`<owner column> = auth.uid()`). Each attempt explicitly includes the
     * verified logged-in user id — never relying on implicit defaults.
     */
    const trimmedTitle: string = draft.title.trim();
    const trimmedPitch: string = draft.blurb.trim();

    // `listings.contact_link` is NOT NULL in the live schema. Normalise the
    // creator's WhatsApp/Telegram input into a deep link; when they leave it
    // blank fall back to the empty-string placeholder so we NEVER send null.
    const normalizedContact: string | null = normalizeContactLink(draft.contactChannel, draft.contactHandle);
    const contactLink: string = normalizedContact ?? CONTACT_LINK_PLACEHOLDER;

    interface ListingPayload {
      readonly [key: string]: string | number | null;
    }

    const baseFields = {
      title: trimmedTitle,
      category: draft.category,
      image_url: draft.imageUrl,
      contact_link: contactLink,
      status: "active",
    } as const;

    const attempts: ReadonlyArray<ListingPayload> = Object.freeze([
      // Shape A — original schema: owner_id + description + price_cents.
      { ...baseFields, owner_id: userId, description: trimmedPitch, price_cents: draft.priceCents },
      // Shape B — current schema: explicit user_id (RLS: user_id = auth.uid()).
      { ...baseFields, user_id: userId, description: trimmedPitch, price_cents: draft.priceCents },
      // Shape C — variant with legacy `blurb` column name.
      { ...baseFields, user_id: userId, blurb: trimmedPitch, price_cents: draft.priceCents },
      // Shape D — variant where price is stored in major units.
      { ...baseFields, user_id: userId, description: trimmedPitch, price: draft.priceCents / 100 },
    ]);

    let lastError: string | null = null;
    for (const payload of attempts) {
      try {
        const { data, error } = await sb.from("listings").insert(payload).select("id").single();
        if (error === null && data !== null) {
          const row: InsertedRow = data as unknown as InsertedRow;
          return succeed({ id: row.id, title: trimmedTitle, isConcept: false, imageUrl: draft.imageUrl });
        }
        lastError = error?.message ?? "Insert returned no row.";
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : "Unknown database error";
      }
    }
    return fail(
      "database",
      `Could not publish the listing: ${lastError ?? "insert failed"}. ` +
        `The 'listings' table must have an owner column (user_id or owner_id) whose RLS insert policy checks it against auth.uid().`,
    );
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : "Publish failed";
    return fail("network", message);
  }
}
