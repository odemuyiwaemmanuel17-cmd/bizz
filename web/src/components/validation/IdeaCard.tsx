import type { ReactElement } from "react";
import { formatPrice } from "../../lib/feed";
import type { SentimentTally, VoteChoice } from "../../lib/ideas";
import type { IdeaWithMyVote } from "../../hooks/useIdeas";
import AnimatedNumber from "../ui/micro";

interface IdeaCardProps {
  readonly idea: IdeaWithMyVote;
  readonly busy: boolean;
  readonly onVote: (ideaId: string, choice: VoteChoice) => void;
}

function TallyBar({ label, percent, count, tone }: { label: string; percent: number; count: number; tone: "bizz" | "fizz" }): ReactElement {
  const barClass: string = tone === "bizz" ? "bg-gradient-to-r from-emerald-400 to-cyanGlow" : "bg-gradient-to-r from-rose-400 to-violetGlow";
  return (
    <div aria-hidden={false}>
      <div className="flex items-center justify-between text-xs font-semibold">
        <span className={tone === "bizz" ? "text-emerald-300" : "text-rose-300"}>
          {label} · <AnimatedNumber value={count} className="tabular-nums" />
        </span>
        <AnimatedNumber value={percent} className="tabular-nums text-slate-300" format={(value: number): string => `${value}%`} />
      </div>
      <div
        role="progressbar"
        aria-label={`${label} sentiment`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/5"
      >
        <div className={`h-full rounded-full transition-all duration-500 ease-out ${barClass}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Concept-phase idea card with live Bizz/Fizz sentiment bars. */
export default function IdeaCard({ idea, busy, onVote }: IdeaCardProps): ReactElement {
  const tally: SentimentTally = idea.tally;
  const verdict: string =
    tally.total === 0
      ? "First reaction welcome 🤞"
      : idea.validated
        ? "✅ Validated — ship it!"
        : tally.bizzPercent >= 60
          ? "Promising — needs more believers"
          : tally.bizzPercent >= 40
            ? "Split crowd — sharpen the pitch"
            : "❄️ Fizzing — back to the lab";

  return (
    <article className="glass flex h-full flex-col gap-4 rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-xl hover:shadow-violetGlow/5">
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-full border border-violetGlow/40 bg-violetGlow/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-violet-300">
          💡 Concept · {idea.category}
        </span>
        <span className="whitespace-nowrap text-xs font-semibold text-slate-400">
          target {formatPrice(idea.targetPriceCents)}
        </span>
      </div>

      <div className="min-w-0">
        <h3 className="truncate text-lg font-semibold text-white">{idea.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-400">{idea.pitch}</p>
        <p className="mt-2 text-[11px] uppercase tracking-wider text-slate-600">by {idea.creatorName}</p>
      </div>

      <div className="flex flex-col gap-3">
        <TallyBar label="🐝 Bizz" percent={tally.bizzPercent} count={tally.bizz} tone="bizz" />
        <TallyBar label="🫧 Fizz" percent={tally.fizzPercent} count={tally.fizz} tone="fizz" />
        <p className={`text-xs font-medium ${idea.validated ? "text-emerald-300" : "text-slate-400"}`}>{verdict}</p>
      </div>

      <div className="mt-auto flex items-center gap-3 pt-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onVote(idea.id, "bizz")}
          aria-pressed={idea.myVote === "bizz"}
          className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-bold transition ${
            idea.myVote === "bizz"
              ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300"
              : "border-white/10 bg-white/5 text-slate-300 hover:border-emerald-400/50 hover:text-emerald-300"
          } ${busy ? "cursor-wait opacity-60" : ""}`}
        >
          🐝 Bizz{idea.myVote === "bizz" ? " ✓" : ""}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onVote(idea.id, "fizz")}
          aria-pressed={idea.myVote === "fizz"}
          className={`flex-1 rounded-xl border px-4 py-2.5 text-sm font-bold transition ${
            idea.myVote === "fizz"
              ? "border-rose-400/60 bg-rose-400/15 text-rose-300"
              : "border-white/10 bg-white/5 text-slate-300 hover:border-rose-400/50 hover:text-rose-300"
          } ${busy ? "cursor-wait opacity-60" : ""}`}
        >
          🫧 Fizz{idea.myVote === "fizz" ? " ✓" : ""}
        </button>
      </div>
      <p className="sr-only" role="status">
        {tally.total} votes: {tally.bizzPercent}% bizz, {tally.fizzPercent}% fizz.
      </p>
    </article>
  );
}
