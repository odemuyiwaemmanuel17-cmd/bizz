import type { AppEnv } from "../types/env";

/** Reads and trims a single Vite env var; returns null when absent/blank. */
function readVar(name: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY"): string | null {
  try {
    const raw: string | undefined = import.meta.env[name];
    if (typeof raw !== "string") return null;
    const trimmed: string = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Defensive: import.meta.env access can throw in exotic SSR contexts.
    return null;
  }
}

/**
 * Pure function that assembles the app environment and reports which
 * required variables are missing so callers can degrade gracefully.
 */
export function resolveEnv(): AppEnv {
  const supabaseUrl: string | null = readVar("VITE_SUPABASE_URL");
  const supabaseAnonKey: string | null = readVar("VITE_SUPABASE_ANON_KEY");

  const missingVars: string[] = [];
  if (supabaseUrl === null) missingVars.push("VITE_SUPABASE_URL");
  if (supabaseAnonKey === null) missingVars.push("VITE_SUPABASE_ANON_KEY");

  return Object.freeze({ supabaseUrl, supabaseAnonKey, missingVars });
}

export const APP_ENV: AppEnv = resolveEnv();
