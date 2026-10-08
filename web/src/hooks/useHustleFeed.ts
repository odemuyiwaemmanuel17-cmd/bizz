import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeToBizzEvents } from "../lib/events";
import {
  DEFAULT_PAGE_SIZE,
  fetchHustleFeed,
  filterCardsBySearch,
  hydrateVotes,
  type FeedCategory,
  type FeedPage,
  type HustleCardData,
} from "../lib/feed";

export interface UseHustleFeedResult {
  readonly items: ReadonlyArray<HustleCardData>;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly category: FeedCategory;
  readonly search: string;
  readonly setSearch: (search: string) => void;
  readonly setCategory: (category: FeedCategory) => void;
  readonly setPage: (page: number) => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly refresh: () => void;
}

const EMPTY_PAGE: FeedPage = Object.freeze({ items: Object.freeze([]), total: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE, error: null });

/** Stateful feed hook: category tab + pagination, with cancellation-safe fetches. */
export function useHustleFeed(initialCategory: FeedCategory = "all"): UseHustleFeedResult {
  const [category, setCategoryState] = useState<FeedCategory>(initialCategory);
  const [page, setPageState] = useState<number>(1);
  const [search, setSearchState] = useState<string>("");
  const [feed, setFeed] = useState<FeedPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<number>(0);

  /** Debounce search so typing doesn't hammer Supabase. */
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  useEffect(() => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);
    return (): void => clearTimeout(timer);
  }, [search]);

  const load = useCallback((): void => {
    const requestId: number = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    void fetchHustleFeed({ category, page, pageSize: DEFAULT_PAGE_SIZE })
      .then(async (result: FeedPage) => {
        if (requestId !== requestIdRef.current) return; // stale response — ignore
        // Hydrate live vote tallies (best effort; never hides listings).
        let items: ReadonlyArray<HustleCardData> = result.items;
        try {
          items = await hydrateVotes(result.items);
        } catch {
          /* decorative only */
        }
        if (requestId !== requestIdRef.current) return;
        setFeed(Object.freeze({ ...result, items }));
        setError(result.error);
        setLoading(false);
      })
      .catch((err: unknown): void => {
        if (requestId !== requestIdRef.current) return;
        // No silent masking: surface unexpected failures in the UI banner.
        setFeed(EMPTY_PAGE);
        setError(err instanceof Error ? err.message : "Feed failed to load");
        setLoading(false);
      });
  }, [category, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Cross-component sync: refetch when a bizz/idea is published, edited or
  // deleted anywhere in the app (e.g. the Post-a-Bizz modal), so newly
  // created listings appear on the marketplace without a manual refresh.
  useEffect(() => subscribeToBizzEvents(() => load()), [load]);

  const setSearch = useCallback((next: string): void => {
    setSearchState(next);
    setPageState(1);
  }, []);

  const setCategory = useCallback((next: FeedCategory): void => {
    setCategoryState(next);
    setPageState(1);
  }, []);

  const setPage = useCallback((next: number): void => {
    setPageState(Math.max(1, Math.trunc(next)));
  }, []);

  const totalPages: number = useMemo(
    (): number => Math.max(1, Math.ceil(feed.total / feed.pageSize)),
    [feed.total, feed.pageSize],
  );

  const next = useCallback((): void => {
    setPageState((current: number) => Math.min(current + 1, Math.max(1, Math.ceil(feed.total / feed.pageSize))));
  }, [feed.total, feed.pageSize]);

  const previous = useCallback((): void => {
    setPageState((current: number) => Math.max(1, current - 1));
  }, []);

  /** Client-side search applied to the fetched page (title/blurb/creator). */
  const items: ReadonlyArray<HustleCardData> = useMemo(
    (): ReadonlyArray<HustleCardData> => filterCardsBySearch(feed.items, debouncedSearch),
    [feed.items, debouncedSearch],
  );

  return {
    items,
    total: feed.total,
    page: feed.page,
    pageSize: feed.pageSize,
    totalPages,
    loading,
    error: error ?? feed.error,
    category,
    search,
    setSearch,
    setCategory,
    setPage,
    next,
    previous,
    refresh: load,
  };
}
