/**
 * Instant-contact deep links.
 *
 * Builds pre-filled WhatsApp (`https://wa.me/<phone>?text=...`) and Telegram
 * (`https://t.me/<username>?text=...`) URLs from a creator's contact handle,
 * so the "Chat with Creator" CTA opens a conversation that already contains a
 * message mentioning the hustle being viewed.
 *
 * Pure module: no DOM access, no side effects — every function is total and
 * returns `null` (never throws) for invalid input, which callers translate into
 * a disabled button state.
 */

export type ContactChannel = "whatsapp" | "telegram";

/** Normalised, validated contact handle ready for URL construction. */
export interface ContactHandle {
  readonly channel: ContactChannel;
  /** Digits-only international MSISDN (no `+`, spaces, dashes or symbols). */
  readonly phoneDigits?: string;
  /** Lower-case Telegram username without the leading `@`. */
  readonly username?: string;
}

export interface ChatLinkResult {
  readonly url: string;
  readonly channel: ContactChannel;
}

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15; // E.164 ceiling
const USERNAME_PATTERN = /^[a-z0-9_]{5,32}$/; // Telegram public-username rules

/**
 * Parses free-form user input ("+91 98765 43210", "@handle", "https://t.me/handle")
 * into a typed handle. Returns null when the value cannot plausibly be used.
 */
export function parseContactHandle(
  channel: ContactChannel,
  rawValue: string | null | undefined,
): ContactHandle | null {
  if (typeof rawValue !== "string") return null;
  const trimmed: string = rawValue.trim();
  if (trimmed.length === 0) return null;

  if (channel === "whatsapp") {
    // Keep only digits; drop a leading country `+`/`00` prefix artefacts.
    const digits: string = trimmed.replace(/[^\d]/g, "").replace(/^00/, "");
    if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
    return Object.freeze({ channel, phoneDigits: digits });
  }

  if (channel === "telegram") {
    // Accept full URLs, bare @handles and plain usernames alike.
    let name: string = trimmed.trim().toLowerCase();
    const tMeMatch: RegExpMatchArray | null = /^https?:\/\/t\.me\/([a-z0-9_]+).*$/i.exec(name);
    if (tMeMatch !== null && tMeMatch[1] !== undefined) name = tMeMatch[1];
    name = name.replace(/^@/, "");
    if (!USERNAME_PATTERN.test(name)) return null;
    return Object.freeze({ channel, username: name });
  }

  // Exhaustiveness guard: unknown channels are rejected rather than guessed.
  const unreachable: never = channel;
  void unreachable;
  return null;
}

/** True when `value` looks like a usable handle for `channel`. */
export function isValidContactHandle(channel: ContactChannel, value: string | null | undefined): boolean {
  return parseContactHandle(channel, value) !== null;
}

/**
 * Default outreach message. Kept generic (no hard-coded brand) so it reads
 * naturally even before listing data is threaded through.
 */
export function defaultMessage(title?: string | null): string {
  const clean: string = typeof title === "string" ? title.trim() : "";
  return clean.length > 0
    ? `Hi! I found your hustle "${clean}" on HustleHub and I'm interested — is it still available?`
    : "Hi! I found your hustle on HustleHub and I'm interested — is it still available?";
}

/**
 * Builds the wa.me deep link. Message text is percent-encoded via
 * encodeURIComponent (spaces become %20, which wa.me renders correctly).
 */
export function buildWhatsAppUrl(phoneDigits: string, message: string): string | null {
  const digits: string = phoneDigits.replace(/[^\d]/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  const text: string = message.trim();
  const query: string = text.length > 0 ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
}

/** Builds a t.me deep link with an optional pre-filled message. */
export function buildTelegramUrl(username: string, message: string): string | null {
  const name: string = username.replace(/^@/, "").toLowerCase();
  if (!USERNAME_PATTERN.test(name)) return null;
  const text: string = message.trim();
  const query: string = text.length > 0 ? `?text=${encodeURIComponent(text)}` : "";
  return `https://t.me/${name}${query}`;
}

/** One-stop helper: handle + message → chat link (or null when unusable). */
export function buildChatLink(handle: ContactHandle, message: string): ChatLinkResult | null {
  if (handle.channel === "whatsapp") {
    if (handle.phoneDigits === undefined) return null;
    const url: string | null = buildWhatsAppUrl(handle.phoneDigits, message);
    return url === null ? null : Object.freeze({ url, channel: handle.channel });
  }
  if (handle.username === undefined) return null;
  const url: string | null = buildTelegramUrl(handle.username, message);
  return url === null ? null : Object.freeze({ url, channel: handle.channel });
}

/**
 * Normalises free-form contact input into a storable deep link for the
 * `listings.contact_link` column. Accepts full URLs (`https://wa.me/...`,
 * `https://t.me/...`) as well as bare handles (phone digits / @username).
 * Returns `null` when the value is empty or unusable — callers must then
 * substitute a non-null placeholder before inserting (the column has a
 * NOT NULL constraint).
 */
export function normalizeContactLink(
  channel: ContactChannel,
  rawValue: string | null | undefined,
): string | null {
  if (typeof rawValue !== "string") return null;
  const trimmed: string = rawValue.trim();
  if (trimmed.length === 0) return null;

  // Already a fully-formed deep link → keep it verbatim (lower-cased host).
  if (/^https?:\/\/(wa\.me|t\.me)\//i.test(trimmed)) return trimmed;

  const handle: ContactHandle | null = parseContactHandle(channel, trimmed);
  if (handle === null) return null;
  if (handle.channel === "whatsapp" && handle.phoneDigits !== undefined) {
    return buildWhatsAppUrl(handle.phoneDigits, "");
  }
  if (handle.channel === "telegram" && handle.username !== undefined) {
    return buildTelegramUrl(handle.username, "");
  }
  return null;
}

/** Placeholder stored when a creator leaves the contact field blank. */
export const CONTACT_LINK_PLACEHOLDER: string = "";

/** Convenience wrapper used directly by the CTA component. */
export function createChatHref(
  channel: ContactChannel,
  rawValue: string | null | undefined,
  message: string,
): string | null {
  const handle: ContactHandle | null = parseContactHandle(channel, rawValue);
  if (handle === null) return null;
  const link: ChatLinkResult | null = buildChatLink(handle, message);
  return link === null ? null : link.url;
}
