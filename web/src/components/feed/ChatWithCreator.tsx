import { useState, type ReactElement } from "react";
import { createChatHref, defaultMessage, parseContactHandle, type ContactChannel } from "../../lib/contact";

interface ChatWithCreatorProps {
  readonly listingTitle: string;
  readonly channel: ContactChannel;
  readonly handle: string;
}

const CHANNEL_META: Readonly<Record<ContactChannel, { label: string; icon: string; accent: string }>> = Object.freeze({
  whatsapp: { label: "Chat on WhatsApp", icon: "\u{1F4AC}", accent: "from-emerald-500/80 to-green-600/80 hover:from-emerald-400 hover:to-green-500" },
  telegram: { label: "Chat on Telegram", icon: "\u2708\uFE0F", accent: "from-sky-500/80 to-blue-600/80 hover:from-sky-400 hover:to-blue-500" },
});

/**
 * "Chat with Creator" CTA. Builds a pre-filled wa.me / t.me deep link at click
 * time (so the message always reflects the current listing title) and opens it
 * in a new tab. Renders a disabled state when the creator has no usable handle.
 */
export default function ChatWithCreator({ listingTitle, channel, handle }: ChatWithCreatorProps): ReactElement {
  const [opened, setOpened] = useState<boolean>(false);
  const meta = CHANNEL_META[channel];
  const valid: boolean = parseContactHandle(channel, handle) !== null;

  const openChat = (): void => {
    if (!valid) return;
    const url: string | null = createChatHref(channel, handle, defaultMessage(listingTitle));
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
        {opened ? "Message ready — chat opened" : "Chat with Creator"}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-full"
      />
    </button>
  );
}
