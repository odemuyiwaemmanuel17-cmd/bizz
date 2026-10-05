import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Session, User } from "@supabase/supabase-js";
import { APP_ENV } from "./env";

export type AuthStatus = "authenticated" | "unauthenticated" | "config-missing";

export interface AuthSnapshot {
  readonly status: AuthStatus;
  readonly user: User | null;
  readonly session: Session | null;
}

type Listener = (snapshot: AuthSnapshot) => void;

/**
 * Lazily-created singleton Supabase client. Returns null (and never throws)
 * when the project is running without env vars configured, so the landing
 * page still works before Phase 3 wires up real credentials.
 */
let client: SupabaseClient | null = null;
let initAttempted = false;

export function getSupabase(): SupabaseClient | null {
  if (initAttempted) return client;
  initAttempted = true;

  const url: string | null = APP_ENV.supabaseUrl;
  const anonKey: string | null = APP_ENV.supabaseAnonKey;
  if (url === null || anonKey === null) {
    console.warn(
      `[supabase] Missing ${APP_ENV.missingVars.join(", ")} — auth runs in offline mode. ` +
        "Copy .env.example to .env.local and fill in your project values.",
    );
    return null;
  }

  try {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch (error: unknown) {
    console.error("[supabase] Failed to initialise client:", error);
    client = null;
  }
  return client;
}

/** True when both Supabase env vars are present and the client was created. */
export function isSupabaseConfigured(): boolean {
  return getSupabase() !== null;
}

/** One-shot session fetch with explicit error handling. */
export async function getSessionSafe(): Promise<AuthSnapshot> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { status: "config-missing", user: null, session: null };
  }
  try {
    const { data, error } = await sb.auth.getSession();
    if (error !== null) throw error;
    const session: Session | null = data.session;
    return {
      status: session !== null ? "authenticated" : "unauthenticated",
      user: session?.user ?? null,
      session,
    };
  } catch (error: unknown) {
    console.error("[supabase] getSession failed:", error);
    return { status: "unauthenticated", user: null, session: null };
  }
}

/** Email magic-link sign-in. Returns a typed success/failure result. */
export async function signInWithMagicLink(
  email: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return {
      ok: false,
      message: "Supabase is not configured yet (missing VITE_SUPABASE_* variables).",
    };
  }
  try {
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error !== null) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, message };
  }
}

/* ------------------------------------------------------------------ */
/* Profile bootstrap                                                   */
/* ------------------------------------------------------------------ */

/**
 * Upserts a `public.profiles` row for the given user so the row ALWAYS exists
 * before any listing/idea insert is attempted (listings.owner_id /
 * listings.user_id carry a FK to profiles.id — missing rows cause foreign
 * key violations). Best-effort by design: failures are logged and resolved
 * silently because a DB-side trigger/backfill may already have created the
 * row, and we never want profile bookkeeping to block sign-in.
 */
export async function ensureProfileRow(user: User): Promise<void> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return;

  const email: string = user.email ?? "";
  const fallbackName: string = email.length > 0 ? email.split("@")[0] ?? "hustler" : "hustler";
  const fullName: string =
    typeof user.user_metadata?.["full_name"] === "string" &&
    (user.user_metadata["full_name"] as string).trim().length > 0
      ? (user.user_metadata["full_name"] as string).trim()
      : fallbackName;
  const avatarUrl: string | null =
    typeof user.user_metadata?.["avatar_url"] === "string"
      ? (user.user_metadata["avatar_url"] as string)
      : null;

  // Live schema variants observed across deployments: this project's
  // profiles table stores (id, email, full_name, avatar_url); older
  // migrations used (id, handle NOT NULL, display_name). Try both shapes
  // so one upsert succeeds regardless of which migration ran last.
  type ProfilePayload = Record<string, string | null>;
  const attempts: ReadonlyArray<ProfilePayload> = Object.freeze<ProfilePayload[]>([
    {
      id: user.id,
      email,
      full_name: fullName,
      avatar_url: avatarUrl,
    },
    {
      id: user.id,
      // handle must be unique + >=2 chars: derive from email, suffix uid slice.
      handle: `${(fallbackName.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "hustler")}_${user.id.replace(/-/g, "").slice(0, 6)}`,
      display_name: fullName,
      avatar_url: avatarUrl,
    },
  ]);

  let lastMessage: string | null = null;
  for (const payload of attempts) {
    try {
      const { error } = await sb.from("profiles").upsert(payload, { onConflict: "id" });
      if (error === null) return;
      lastMessage = error.message;
    } catch (err: unknown) {
      lastMessage = err instanceof Error ? err.message : "Unknown error";
    }
  }
  console.warn("[supabase] Could not upsert profile row:", lastMessage);
}

/**
 * Resolves the acting user with SERVER-side verification (`getUser()` hits
 * GoTrue, refreshes tokens, and returns the authoritative uid that RLS
 * policies compare against), then guarantees the matching `profiles` row
 * exists. Call this right after any successful sign-in/sign-up/OAuth return
 * and before any insert into listings/ideas.
 */
export async function bootstrapAuthenticatedUser(): Promise<AuthSnapshot> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return { status: "config-missing", user: null, session: null };
  try {
    const { data, error } = await sb.auth.getUser();
    if (error !== null) throw error;
    const user: User | null = data.user ?? null;
    if (user === null) return { status: "unauthenticated", user: null, session: null };
    await ensureProfileRow(user);
    return { status: "authenticated", user, session: null };
  } catch (err: unknown) {
    console.error("[supabase] bootstrapAuthenticatedUser failed:", err);
    // Fall back to the locally cached session so offline token expiry does
    // not lock the user out of their own dashboard.
    return getSessionSafe();
  }
}

export type AuthResult = { ok: true } | { ok: false; message: string };

/** Email/password sign-up. Creates the auth user (profile row is auto-created by trigger). */
export async function signUpWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: false, message: "Supabase is not configured yet (missing VITE_SUPABASE_* variables)." };
  }
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + "/dashboard" },
    });
    if (error !== null) return { ok: false, message: error.message };
    // Guarantee the profiles row exists immediately after sign-up so the
    // first listing insert never hits a foreign key violation. When email
    // confirmation is required there is no session yet; the auth-state
    // listener performs the same bootstrap on confirmation/first sign-in.
    if (data.user !== null && data.session !== null) {
      await ensureProfileRow(data.user);
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Unknown error" };
  }
}

/** Email/password sign-in. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: false, message: "Supabase is not configured yet (missing VITE_SUPABASE_* variables)." };
  }
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error !== null) return { ok: false, message: error.message };
    // Upsert the profiles row right after a successful sign-in so any
    // subsequent listing insert satisfies the owner FK to public.profiles.
    if (data.user !== null && data.session !== null) {
      await ensureProfileRow(data.user);
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Unknown error" };
  }
}

/** Google OAuth redirect flow. On success the browser navigates away; errors resolve typed. */
export async function signInWithGoogle(): Promise<AuthResult> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    return { ok: false, message: "Supabase is not configured yet (missing VITE_SUPABASE_* variables)." };
  }
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/dashboard" },
    });
    if (error !== null) return { ok: false, message: error.message };
    return { ok: true }; // redirect in flight
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Unknown error" };
  }
}

/** Sign out; always resolves to an ok snapshot on failure so UI can reset. */
export async function signOut(): Promise<AuthSnapshot> {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) return { status: "config-missing", user: null, session: null };
  try {
    const { error } = await sb.auth.signOut();
    if (error !== null) console.error("[supabase] signOut error:", error.message);
  } catch (error: unknown) {
    console.error("[supabase] signOut threw:", error);
  }
  return { status: "unauthenticated", user: null, session: null };
}

/**
 * Subscribe to auth changes. Returns an unsubscribe function. When Supabase
 * is unconfigured the listener fires once with a config-missing snapshot.
 */
export function subscribeToAuth(listener: Listener): () => void {
  const sb: SupabaseClient | null = getSupabase();
  if (sb === null) {
    listener({ status: "config-missing", user: null, session: null });
    return () => undefined;
  }
  const { data } = sb.auth.onAuthStateChange((event, session) => {
    listener({
      status: session !== null ? "authenticated" : "unauthenticated",
      user: session?.user ?? null,
      session,
    });
    // Bootstrap the profiles row whenever a session lands in the client —
    // covers OAuth redirects (Google), magic-link confirmations and page
    // loads with a persisted session. Fire-and-forget; never blocks UI.
    if (session !== null && event !== "SIGNED_OUT") {
      void ensureProfileRow(session.user);
    }
  });
  return () => data.subscription.unsubscribe();
}
