import { useEffect, useState, type MouseEvent, type ReactElement } from "react";
import { formatPrice, type HustleCardData } from "../../lib/feed";
import { toggleListingLike, type ToggleLikeResult } from "../../lib/listingLikes";
import { useToast } from "../ui/Toaster";
import CategoryBadge from "./CategoryBadge";
import CreatorChip from "./CreatorChip";
import ChatWithCreator from "./ChatWithCreator";

interface HustleCardProps {
  readonly card: HustleCardData;
  /** Whether the CURRENT user already liked this listing (from listing_likes). */
  readonly isLiked?: boolean;
  /** Live like count derived from public.listing_likes rows. */
  readonly likeCount?: number;
}

const STOCK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  services: "Available for booking",
  tech: "Remote · fast turnaround",
  campus: "On-campus delivery",
  digital: "Instant digital delivery",
});

/**
 * Marketplace listing card. The heart/like control writes to
 * `public.listing_likes` (listing_id + user_id, UNIQUE) — it is deliberately
 * SEPARATE from the Bizz/Fizz validation system (ideas → idea_votes). Like
 * counts come from real listing_likes rows supplied by the feed hook; the
 * stale `listings.votes_count` column is not used.
 */
export default function HustleCard({ card, isLiked = false, likeCount = 0 }: HustleCardProps): ReactElement {
  const votesCount: number = Number.isFinite(likeCount) ? Math.max(0, Math.trunc(likeCount)) : 0;

  /* ---- local like state (optimistic UI with rollback) ---- */
  const [liked, setLiked] = useState<boolean>(isLiked);
  const [count, setCount] = useState<number>(votesCount);
  const [busy, setBusy] = useState<boolean>(false);
  const toast = useToast();

  // Re-sync when the parent refetches fresh server truth (e.g. after a page
  // refresh or a likes-hydration update from the feed hook).
  useEffect(() => {
    if (!busy) {
      setLiked(isLiked);
      setCount(votesCount);
    }
  }, [isLiked, votesCount, busy]);

  const handleLike = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    const prevLiked: boolean = liked;
    const prevCount: number = count;
    // Optimistic flip
    setLiked(!prevLiked);
    setCount(Math.max(0, prevCount + (prevLiked ? -1 : 1)));
    try {
      const result: ToggleLikeResult = await toggleListingLike(card.id);
      if (result.ok === true) {
        // Settle on the authoritative outcome (idempotent when it matches).
        setLiked(result.liked);
        setCount(Math.max(0, prevCount + (result.liked && !prevLiked ? 1 : !result.liked && prevLiked ? -1 : 0)));
      } else {
        // Rollback optimistic UI, then surface honest feedback.
        setLiked(prevLiked);
        setCount(prevCount);
        if (result.reason === "auth-required") {
          toast.push({ title: "Sign in required", description: result.message, tone: "info" });
        } else {
          toast.push({ title: "Could not update your like", description: result.message, tone: "error" });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="glass group relative isolate flex h-full flex-col gap-4 rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-xl hover:shadow-indigoGlow/5">
      {/* Decorative gradient overlay must never intercept the mouse. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-3xl bg-gradient-to-br from-indigoGlow/5 via-transparent to-violetGlow/5" />
      <div className="flex items-start justify-between gap-3">
        <CategoryBadge category={card.category} />
        <span className="rounded-full bg-gradient-to-r from-indigoGlow/20 to-violetGlow/20 px-3 py-1 text-sm font-bold text-white ring-1 ring-white/10">
          {formatPrice(card.priceCents, card.currency)}
        </span>
      </div>

      <div className="min-w-0">
        <h3 className="truncate text-lg font-semibold text-white">{card.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-400">{card.blurb}</p>
        <p className="mt-2 text-[11px] uppercase tracking-wider text-slate-600">{STOCK_LABELS[card.category] ?? "Active listing"}</p>
      </div>

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <CreatorChip creator={card.creator} />
          <button
            type="button"
            data-bizz-like-button
            onClick={handleLike}
            disabled={busy}
            aria-label={liked ? "Unlike Bizz" : "Like Bizz"}
            aria-pressed={liked}
            contentEditable={false}
            className={`!cursor-pointer relative z-[9999] inline-flex shrink-0 select-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              liked
                ? "border-pink-400/40 bg-pink-500/15 text-pink-300"
                : "border-white/10 bg-white/5 text-slate-400 hover:text-pink-300"
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="pointer-events-none h-4 w-4"
              fill={liked ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
            <span className="pointer-events-none tabular-nums">{count.toLocaleString("en-US")}</span>
          </button>
        </div>
        <ChatWithCreator
          listingTitle={card.title}
          contactLink={card.contactLink}
          channel={card.contactChannel}
          handle={card.contactHandle}
        />
      </div>
    </article>
  );
}
