import { type ReactElement } from "react";
import { formatPrice, type HustleCardData } from "../../lib/feed";
import CategoryBadge from "./CategoryBadge";
import CreatorChip from "./CreatorChip";
import ChatWithCreator from "./ChatWithCreator";

interface HustleCardProps {
  readonly card: HustleCardData;
}

const STOCK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  services: "Available for booking",
  tech: "Remote · fast turnaround",
  campus: "On-campus delivery",
  digital: "Instant digital delivery",
});

/**
 * Marketplace listing card. NOTE: the 👍 "validation vote" affordance was
 * removed because the live `votes` table now carries an `idea_id` column and
 * no `listing_id` — writing to it with a listing id fails (and would fake
 * marketplace votes using idea infrastructure). Bizz/Fizz voting lives
 * exclusively in the Validation Arena against `idea_votes`. Listing vote
 * counts render as honest zeros until a proper marketplace-votes schema
 * exists.
 */
export default function HustleCard({ card }: HustleCardProps): ReactElement {
  const votesCount: number = Number.isFinite(card.votesCount) ? Math.max(0, Math.trunc(card.votesCount)) : 0;

  return (
    <article className="glass group flex h-full flex-col gap-4 rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-xl hover:shadow-indigoGlow/5">
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
          <span
            aria-label={`Validation interest: ${votesCount.toLocaleString("en-US")} (marketplace voting coming soon)`}
            title="Marketplace validation voting is coming soon"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-400"
          >
            <span aria-hidden="true">👍</span>
            {votesCount.toLocaleString("en-US")}
          </span>
        </div>
        <ChatWithCreator listingTitle={card.title} channel={card.contactChannel} handle={card.contactHandle} />
      </div>
    </article>
  );
}
