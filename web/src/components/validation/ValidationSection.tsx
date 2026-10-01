import { useCallback, useState, type ReactElement } from "react";
import { useIdeas, type IdeaWithMyVote } from "../../hooks/useIdeas";
import { useAuth } from "../../hooks/useAuth";
import type { VoteChoice } from "../../lib/ideas";
import { useToast } from "../ui/Toaster";
import IdeaCard from "./IdeaCard";

function SkeletonIdea(): ReactElement {
  return (
    <div className="glass h-80 animate-pulse rounded-3xl p-6">
      <div className="h-5 w-32 rounded-full bg-white/10" />
      <div className="mt-6 h-5 w-3/4 rounded bg-white/10" />
      <div className="mt-3 h-4 w-full rounded bg-white/5" />
      <div className="mt-8 h-2.5 w-full rounded-full bg-white/10" />
      <div className="mt-3 h-2.5 w-2/3 rounded-full bg-white/5" />
      <div className="mt-10 h-10 w-full rounded-xl bg-white/10" />
    </div>
  );
}

/** Community validation section: concept ideas + real-time Bizz/Fizz tallies. */
export default function ValidationSection(): ReactElement {
  const { ideas, loading, error, refresh, vote } = useIdeas();
  const auth = useAuth();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleVote = useCallback(
    async (ideaId: string, choice: VoteChoice): Promise<void> => {
      if (busyId !== null) return;
      setBusyId(ideaId);
      const ok: boolean = await vote(ideaId, choice);
      const idea: IdeaWithMyVote | undefined = ideas.find((candidate: IdeaWithMyVote): boolean => candidate.id === ideaId);
      if (ok) {
        if (idea?.myVote === null || idea === undefined) {
          toast.push({ title: "Vote counted", description: `Your ${choice === "bizz" ? "🐝 Bizz" : "🫧 Fizz"} is in — tallies update live.`, tone: "success" });
        } else {
          toast.push({
            title: idea.myVote === choice ? "Vote removed" : "Vote switched",
            description:
              idea.myVote === choice
                ? "Toggled off — the tally dropped back down."
                : `Now counting as ${choice === "bizz" ? "🐝 Bizz" : "🫧 Fizz"}.`,
            tone: "success",
          });
        }
      } else {
        toast.push({
          title: auth.isAuthenticated ? "Couldn't record your vote" : "Sign in to lock in your vote",
          description: auth.isAuthenticated ? "Check your connection and try again." : "Magic-link sign-in takes five seconds.",
          tone: "error",
        });
      }
      setBusyId(null);
    },
    [auth.isAuthenticated, busyId, ideas, toast, vote],
  );

  const totalVoters: number = ideas.reduce((sum: number, idea: IdeaWithMyVote) => sum + idea.tally.total, 0);

  return (
    <section id="validate" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-violet-400">Bizz or Fizz</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Validate before you <span className="text-gradient">build</span>
          </h2>
          <p className="mt-2 max-w-xl text-slate-400">
            Early-stage concepts drop here. One tap tells the founder whether this is a
            bizz worth chasing or a fizz to forget — tallies update in real time.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="whitespace-nowrap text-sm text-slate-500">
            {loading ? "Loading…" : `${ideas.length} concepts · ${totalVoters.toLocaleString("en-US")} votes cast`}
          </p>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {error} — showing demo data instead.{" "}
          <button type="button" onClick={refresh} className="underline hover:text-white">
            Retry
          </button>
        </p>
      )}

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {loading
          ? Array.from({ length: 3 }, (_unused: undefined, index: number) => <SkeletonIdea key={`idea-skeleton-${index}`} />)
          : ideas.map((idea: IdeaWithMyVote) => (
              <IdeaCard key={idea.id} idea={idea} busy={busyId === idea.id} onVote={(id, choice) => void handleVote(id, choice)} />
            ))}
      </div>

      {!loading && ideas.length === 0 && (
        <div className="glass mt-10 rounded-3xl p-12 text-center">
          <p className="text-lg font-semibold text-white">The validation pool is empty</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            Drop your first concept with “Post a Bizz” and let the community call it.
          </p>
        </div>
      )}
    </section>
  );
}
