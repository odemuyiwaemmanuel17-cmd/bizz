/** `/discover` — marketplace feed only: active gigs, category tabs, search. */
import type { ReactElement } from "react";
import HustleFeed from "../components/feed/HustleFeed";

export default function DiscoverPage(): ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-28 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
          Discover hustles
        </h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 sm:text-base">
          Browse active student &amp; hustler gigs. Filter by category or search
          for exactly what you need.
        </p>
      </header>
      <HustleFeed />
    </div>
  );
}
