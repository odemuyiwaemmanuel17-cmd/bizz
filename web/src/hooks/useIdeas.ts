import { useCallback, useEffect, useState } from "react";
import {
  fetchIdeas,
  fetchMyIdeaVote,
  subscribeToIdeaVotes,
  type IdeaPage,
  type ValidationIdea,
  type VoteChoice,
  castIdeaVote,
} from "../lib/ideas";

export interface IdeaWithMyVote extends ValidationIdea {
  readonly myVote: VoteChoice | null;
}

export interface UseIdeasResult {
  readonly ideas: ReadonlyArray<IdeaWithMyVote>;
  readonly loading: boolean;
  readonly error: string | null;
  /** Refetches the idea list; returns a cancel function for pending work. */
  readonly refresh: () => () => void;
  /** Casts/switches/toggles the caller's vote; returns false when it failed. */
  readonly vote: (ideaId: string, choice: VoteChoice) => Promise<boolean>;
}

const EMPTY: IdeaPage = Object.freeze({ items: Object.freeze([]), error: null });

/**
 * Live list of concept-phase ideas with realtime bizz/fizz tallies.
 * Falls back to the offline demo ledger when Supabase is not configured.
 */
export function useIdeas(): UseIdeasResult {
  const [page, setPage] = useState<IdeaPage>(EMPTY);
  const [myVotes, setMyVotes] = useState<ReadonlyMap<string, VoteChoice | null>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback((): (() => void) => {
    let cancelled: boolean = false;
    setLoading(true);
    void fetchIdeas().then(async (result: IdeaPage) => {
      if (cancelled) return;
      setPage(result);
      setLoading(false);
      const votes: Array<readonly [string, VoteChoice | null]> = await Promise.all(
        result.items.map(async (idea: ValidationIdea): Promise<readonly [string, VoteChoice | null]> => {
          const myVote: VoteChoice | null = await fetchMyIdeaVote(idea.id);
          return [idea.id, myVote] as const;
        }),
      );
      if (cancelled) return;
      setMyVotes(new Map<string, VoteChoice | null>(votes));
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancelLoad: () => void = load();
    // Realtime: refetch tallies for the changed idea (debounced by React state batching).
    const unsubscribe: () => void = subscribeToIdeaVotes(() => {
      void fetchIdeas().then((result: IdeaPage) => setPage(result));
    });
    return (): void => {
      cancelLoad();
      unsubscribe();
    };
  }, [load]);

  const vote = useCallback(async (ideaId: string, choice: VoteChoice): Promise<boolean> => {
    // Optimistic re-render happens after the authoritative outcome arrives;
    // keep this simple and correct rather than racing the server tally.
    const outcome = await castIdeaVote(ideaId, choice);
    if (outcome.ok) {
      setPage((prev: IdeaPage): IdeaPage =>
        Object.freeze({
          ...prev,
          items: Object.freeze(
            prev.items.map((idea: ValidationIdea): ValidationIdea =>
              idea.id === ideaId
                ? Object.freeze({
                    ...idea,
                    tally: outcome.tally,
                    validated: outcome.tally.bizz >= 50 && outcome.tally.bizzPercent >= 60,
                  })
                : idea,
            ),
          ),
        }),
      );
      setMyVotes((prev: ReadonlyMap<string, VoteChoice | null>): ReadonlyMap<string, VoteChoice | null> => {
        const next: Map<string, VoteChoice | null> = new Map(prev);
        next.set(ideaId, outcome.myVote);
        return next;
      });
      return true;
    }
    return false;
  }, []);

  const ideas: ReadonlyArray<IdeaWithMyVote> = page.items.map((idea: ValidationIdea): IdeaWithMyVote => ({
    ...idea,
    myVote: myVotes.get(idea.id) ?? null,
  }));

  return { ideas, loading, error: page.error, refresh: load, vote };
}
