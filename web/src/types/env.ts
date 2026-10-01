/**
 * Validated, immutable view over the Vite environment variables.
 */
export interface AppEnv {
  readonly supabaseUrl: string | null;
  readonly supabaseAnonKey: string | null;
  readonly missingVars: readonly string[];
}
