import type { User } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import { ensureProfileRow, getSupabase } from "./supabase";
import { APP_ENV } from "./env";

export interface CreatorProfileForm {
  username: string;
  display_name: string;
  bio: string;
  avatar_url: string;
  campus: string;
  state: string;
  country: string;
  creator_type: string;
}

export interface CreatorProfileData extends CreatorProfileForm {
  id: string;
  is_verified: boolean;
}

export interface CreatorProfileRow {
  readonly id: string;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly bio: string | null;
  readonly avatar_url: string | null;
  readonly campus: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly creator_type: string | null;
  readonly is_verified: boolean | null;
}

export const EMPTY_CREATOR_PROFILE_FORM: CreatorProfileForm = {
  username: "",
  display_name: "",
  bio: "",
  avatar_url: "",
  campus: "",
  state: "",
  country: "",
  creator_type: "",
};

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_]/g, "");
}

export function creatorProfileFromRow(row: CreatorProfileRow | null): CreatorProfileData | null {
  if (row === null) return null;
  return {
    id: row.id,
    username: row.username ?? "",
    display_name: row.display_name ?? "",
    bio: row.bio ?? "",
    avatar_url: row.avatar_url ?? "",
    campus: row.campus ?? "",
    state: row.state ?? "",
    country: row.country ?? "",
    creator_type: row.creator_type ?? "",
    is_verified: row.is_verified === true,
  };
}

export function profileFormFromData(initial: CreatorProfileData | null, user: User): CreatorProfileForm {
  if (initial !== null) {
    return {
      username: initial.username,
      display_name: initial.display_name,
      bio: initial.bio,
      avatar_url: initial.avatar_url,
      campus: initial.campus,
      state: initial.state,
      country: initial.country,
      creator_type: initial.creator_type,
    };
  }

  return {
    ...EMPTY_CREATOR_PROFILE_FORM,
    display_name: String(user.user_metadata?.["full_name"] ?? ""),
  };
}

export async function saveCreatorProfile(user: User, form: CreatorProfileForm): Promise<CreatorProfileData> {
  const username = normalizeUsername(form.username);
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    throw new Error("Username must be 3–30 characters using letters, numbers, or underscores.");
  }

  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");

  // Auth normally bootstraps this row, but setup must also work for an older
  // account or a database where that trigger has not run yet.
  await ensureProfileRow(user);

  const duplicate = await sb
    .from("profiles")
    .select("id")
    .eq("username", username)
    .neq("id", user.id)
    .maybeSingle();
  if (duplicate.error !== null) throw new Error(duplicate.error.message);
  if (duplicate.data !== null) throw new Error("That username is already taken.");

  const payload = {
    username,
    display_name: form.display_name.trim() || null,
    bio: form.bio.trim() || null,
    avatar_url: form.avatar_url.trim() || null,
    campus: form.campus.trim() || null,
    state: form.state.trim() || null,
    country: form.country.trim() || null,
    creator_type: form.creator_type.trim() || null,
  };
  const result = await sb.from("profiles").update(payload).eq("id", user.id).select("*").single();
  if (result.error !== null || result.data === null) {
    throw new Error(result.error?.message ?? "Profile could not be saved.");
  }

  const row = result.data as { readonly is_verified?: boolean };
  return {
    id: user.id,
    username,
    display_name: form.display_name.trim(),
    bio: form.bio.trim(),
    avatar_url: form.avatar_url.trim(),
    campus: form.campus.trim(),
    state: form.state.trim(),
    country: form.country.trim(),
    creator_type: form.creator_type.trim(),
    is_verified: row.is_verified === true,
  };
}

export function validateVideoFile(file: File | null): string | null {
  if (file === null) return "Choose a video before publishing.";
  if (!file.type.startsWith("video/")) return "Choose a video file.";
  if (file.size > 100 * 1024 * 1024) return "Video must be 100 MB or smaller.";
  return null;
}

export async function publishCreatorVideo(
  user: User,
  file: File,
  caption: string,
  onStatus?: (status: "uploading" | "saving") => void,
  onProgress?: (percent: number) => void,
  listingId?: string | null,
): Promise<{ readonly id: string; readonly storagePath: string; readonly videoUrl: string }> {
  const validationError = validateVideoFile(file);
  if (validationError !== null) throw new Error(validationError);
  if (caption.trim().length > 280) throw new Error("Caption must be 280 characters or fewer.");

  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "video";
  const randomId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const storagePath = `${user.id}/${randomId}-${safeName}`;
  const storage = sb.storage.from("creator-videos");
  onStatus?.("uploading");
  if (APP_ENV.supabaseUrl === null || APP_ENV.supabaseAnonKey === null) throw new Error("Supabase is not configured.");
  const session = await sb.auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (accessToken === undefined) throw new Error("Your session expired. Sign in again before uploading.");

  // Supabase recommends resumable TUS uploads for larger files. The previous
  // single-request upload could appear frozen on slow connections and could
  // not resume after a dropped connection.
  // Keep medium files on the faster single-request path. TUS has extra
  // handshake/chunk overhead, so using it for every file made short videos
  // noticeably slower. Large files use 20 MB chunks to reduce round trips.
  if (file.size > 20 * 1024 * 1024) {
    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(file, {
        endpoint: `${APP_ENV.supabaseUrl}/storage/v1/upload/resumable`,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        chunkSize: 20 * 1024 * 1024,
        headers: { authorization: `Bearer ${accessToken}`, apikey: APP_ENV.supabaseAnonKey as string, "x-upsert": "false" },
        metadata: { bucketName: "creator-videos", objectName: storagePath, contentType: file.type, cacheControl: "3600" },
        onProgress: (sent: number, total: number) => onProgress?.(Math.round((sent / total) * 100)),
        onSuccess: () => resolve(),
        onError: (error: Error) => reject(new Error(`Video storage upload failed: ${error.message}`)),
      });
      upload.start();
    });
  } else {
    const uploaded = await storage.upload(storagePath, file, { contentType: file.type, upsert: false });
    if (uploaded.error !== null) throw new Error(`Video storage upload failed: ${uploaded.error.message}`);
    onProgress?.(100);
  }

  const videoUrl = storage.getPublicUrl(storagePath).data.publicUrl;
  try {
    onStatus?.("saving");
    const inserted = await sb
      .from("creator_videos")
      .insert({
        user_id: user.id,
        storage_path: storagePath,
        video_url: videoUrl,
        caption: caption.trim() || null,
        status: "published",
        listing_id: listingId ?? null,
      })
      .select("id")
      .single();
    if (inserted.error !== null || inserted.data === null) {
      throw new Error(inserted.error?.message ?? "Video record could not be published.");
    }
    const row = inserted.data as { readonly id: string };
    return { id: row.id, storagePath, videoUrl };
  } catch (error: unknown) {
    // A database failure should not leave an unreferenced object in storage.
    try {
      await storage.remove([storagePath]);
    } catch {
      // Keep the original publish error visible to the creator.
    }
    if (error instanceof Error && error.message.includes("video_url") && error.message.includes("schema cache")) {
      throw new Error("Your Supabase creator_videos table is missing video_url. Run the creator-video migration in supabase/schema-patch.sql, then try again.");
    }
    if (error instanceof Error && error.message.startsWith("Video record could not be published:")) {
      throw error;
    }
    throw new Error(error instanceof Error ? `Video record could not be published: ${error.message}` : "Video record could not be published.");
  }
}
