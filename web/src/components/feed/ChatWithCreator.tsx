import { useState, type ReactElement } from "react";
import {
  channelFromContactLink,
  createChatHref,
  defaultMessage,
  parseContactHandle,
  resolveContactHref,
  type ContactChannel,
} from "../../lib/contact";

interface ChatWithCreatorProps {
  readonly listingTitle: string;
  /** Canonical listings.contact_link value (source of truth). */
  readonly contactLink?: string | null;
  /** Legacy profile-based handle (fallback only). */
  readonly channel?: ContactChannel;
  readonly handle?: string;
}

const CHANNEL_META: Readonly<Record<ContactChannel, { label: string; icon: string; accent: string }>> = Object.freeze({
  whatsapp: { label: "Chat on WhatsApp", icon: "\u{1F4AC}", accent: "from-emerald-500/80 to-green-600/80 hover:from-emerald-400 hover:to-green-500" },
  telegram: { label: "Chat on Telegram", icon: "\u2708\uFE0F", accent: "from-sky-500/80 to-blue-600/80 hover:from-sky-400 hover:to-blue-500" },
});

/**
 * "Chat with Creator" CTA. Prefers the canonical `listings.contact_link` deep
 * link stored on the row itself; falls back to the creator's profile handle.
 * Builds a pre-filled wa.me / t.me message at click time and opens it in a new
 * tab. Renders a disabled state ONLY when both sources are genuinely empty.
 */
export default function ChatWithCreator({
  listingTitle,
  contactLink,
  channel = "whatsapp",
  handle = "",
}: ChatWithCreatorProps): ReactElement {
  const [opened, setOpened] = useState<boolean>(false);

  // Trace layer 5→6: what actually reaches the card, straight from Supabase.
  if (typeof window !== "undefined" && window.location.hostname !== "localhost") {
    console.log("CONTACT DEBUG", { listingTitle, contactLink, handle });
  }

  // Resolution order: canonical contact_link → legacy profile handle.
  const resolvedHref: string | null = resolveContactHref(contactLink) ?? createChatHref(channel, handle, "");
  const effectiveChannel: ContactChannel =
    resolveContactHref(contactLink) !== null ? channelFromContactLink(contactLink) : channel;
  const valid: boolean = resolvedHref !== null || parseContactHandle(channel, handle) !== null;
  const meta = CHANNEL_META[valid ? effectiveChannel : channel];

  const openChat = (): void => {
    const url: string | null =
      resolvedHref ?? createChatHref(effectiveChannel, handle, defaultMessage(listingTitle));
    if (url === null) return;
    window.open(url, "_blank", "noopener,noreferrer");
    setOpened(true);
  };

  if (!valid) {
    return (
      <button
        type="button"
        disabled
        title="This creator has not published a contact handle yet"
        className="w-full cursor-not-allowed rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-500"
      >
        Contact unavailable
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={openChat}
      aria-label={`${meta.label}: send a pre-filled message to the creator of ${listingTitle}`}
      className={`group relative w-full overflow-hidden rounded-xl bg-gradient-to-r px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-black/30 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 ${meta.accent}`}
    >
      <span className="relative z-10 flex items-center justify-center gap-2">
        <span aria-hidden="true">{meta.icon}</span>
        {opened ? "Message ready — chat opened" : meta.label}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-full"
      />
    </button>
  );
}
