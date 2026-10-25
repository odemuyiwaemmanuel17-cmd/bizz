/** Keeps post-auth redirects inside this SPA and rejects external URLs. */
export function safeAuthReturnPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
