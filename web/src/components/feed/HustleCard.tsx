import { useCallback, useEffect, useState, type ReactElement } from "react";
import { formatPrice, type HustleCardData } from "../../lib/feed";
import { fetchVoteState, seedOfflineVotes, submitVote, type VoteState } from "../../lib/votes";
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

/** Modular discovery card: title, price tag, category badge, creator + CTA. */
export default function HustleCard({ card }: HustleCardProps): ReactElement {
  const [vote, setVote] = useState<VoteState>({ voted: false, votesCount: card.votesCount });
  const [pending, setPending] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Seed the offline demo tally and hydrate the caller's own vote state.
    seedOfflineVotes(card.id, card.votesCount);
    let cancelled: boolean = false;
    void fetchVoteState(card.id, card.votesCount).then((state: VoteState) => {
      if (!cancelled) setVote(state);
    });
    return (): void => {
      cancelled = true;
    };
  }, [card.id, card.votesCount]);

  const toggleVote = useCallback(async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    // Optimistic flip; reconciled with the authoritative result below.
    setVote((prev: VoteState) => ({
      voted: !prev.voted,
      votesCount: Math.max(0, prev.votesCount + (prev.voted ? -1 : 1)),
    }));
    const result = await submitVote(card.id, card.votesCount);
    if (result.ok) {
      setVote(result.state);
    } else {
      setVote((prev: VoteState) => ({ voted: !prev.voted, votesCount: Math.max(0, prev.votesCount + (prev.voted ? 1 : -1)) }));
      setNotice(
        result.error === "not-authenticated"
          ? "Sign in to cast a validation vote."
          : "Couldn't reach the vote ledger — try again.",
      );
    }
    setPending(false);
  }, [card.id, card.votesCount, pending]);

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
          <button
            type="button"
            onClick={() => void toggleVote()}
            disabled={pending}
            aria-pressed={vote.voted}
            aria-label={`Validate ${card.title} (${vote.votesCount} votes)`}
            title="I would buy this — validation vote"
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
              vote.voted
                ? "border-cyanGlow/50 bg-cyanGlow/15 text-cyanGlow"
                : "border-white/10 bg-white/5 text-slate-300 hover:border-cyanGlow/40 hover:text-cyanGlow"
            } ${pending ? "opacity-60" : ""}`}
          >
            <span aria-hidden="true">{vote.voted ? "\u2713" : "\uD83D\uDC4D"}</span>
            {vote.votesCount.toLocaleString("en-US")}
          </button>
        </div>
        {notice !== null && <p role="status" className="text-[11px] text-amber-300">{notice}</p>}
        <ChatWithCreator listingTitle={card.title} channel={card.contactChannel} handle={card.contactHandle} />
      </div>
    </article>
  );
}
