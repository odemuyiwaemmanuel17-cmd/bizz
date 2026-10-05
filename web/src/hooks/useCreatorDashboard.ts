/** React hook: loads the signed-in creator's dashboard data. */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./useAuth";
import {
  fetchCreatorDashboard,
  type DashboardIdea,
  type DashboardListing,
  type DashboardStats,
  type DashboardResult,
} from "../lib/dashboard";

export interface UseCreatorDashboardResult {
  readonly isAuthenticated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly listings: ReadonlyArray<DashboardListing>;
  readonly ideas: ReadonlyArray<DashboardIdea>;
  readonly stats: DashboardStats;
  readonly refresh: () => Promise<void>;
}

const EMPTY_STATS: DashboardStats = Object.freeze({
  listingsPosted: 0,
  conceptsPosted: 0,
  validatedIdeas: 0,
  totalVotesReceived: 0,
});

export function useCreatorDashboard(): UseCreatorDashboardResult {
  const auth = useAuth();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<ReadonlyArray<DashboardListing>>(Object.freeze([]));
  const [ideas, setIdeas] = useState<ReadonlyArray<DashboardIdea>>(Object.freeze([]));
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);

  const userId: string | null = auth.user?.id ?? null;

  const load = useCallback(async (): Promise<void> => {
    if (userId === null) {
      setListings(Object.freeze([]));
      setIdeas(Object.freeze([]));
      setStats(EMPTY_STATS);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const result: DashboardResult = await fetchCreatorDashboard(userId);
    if (result.ok) {
      setListings(result.listings);
      setIdeas(result.ideas);
      setStats(result.stats);
    } else {
      setError(result.message);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    isAuthenticated: auth.isAuthenticated && userId !== null,
    loading,
    error,
    listings,
    ideas,
    stats,
    refresh: load,
  };
}
