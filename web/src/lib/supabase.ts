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
  const { data } = sb.auth.onAuthStateChange((_event, session) => {
    listener({
      status: session !== null ? "authenticated" : "unauthenticated",
      user: session?.user ?? null,
      session,
    });
  });
  return () => data.subscription.unsubscribe();
}
