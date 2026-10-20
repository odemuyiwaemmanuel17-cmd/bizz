/** `/discover` — marketplace feed only: active gigs, category tabs, search. */
import { useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import HustleFeed from "../components/feed/HustleFeed";
import VideosPage from "./VideosPage";
import { Link } from "react-router-dom";

export default function DiscoverPage(): ReactElement {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"videos" | "bizzes" | "creators">(searchParams.get("mode") === "bizzes" ? "bizzes" : searchParams.get("mode") === "creators" ? "creators" : "videos");
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-28 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">Discover HustleHub</h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 sm:text-base">
          Watch creators, explore Bizzes, and find the people building useful businesses around you.
        </p>
      </header>
      <div role="tablist" aria-label="Discovery modes" className="mb-6 flex max-w-xl gap-2 overflow-x-auto rounded-2xl bg-white/5 p-1">
        {(["videos", "bizzes", "creators"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => setMode(item)} className={`rounded-xl px-4 py-2 text-sm font-semibold capitalize ${mode === item ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>{item === "videos" ? "Videos" : item === "bizzes" ? "Bizzes" : "Creators"}</button>)}
      </div>
      {mode === "videos" && <VideosPage />}
      {mode === "bizzes" && <HustleFeed />}
      {mode === "creators" && <section className="glass rounded-3xl p-8 text-center"><h2 className="text-xl font-bold text-white">Creator discovery</h2><p className="mx-auto mt-2 max-w-md text-sm text-slate-400">Open a creator profile from any video or Bizz to explore their videos, Bizzes, and ideas.</p><Link to="/videos" className="btn-primary mt-5 inline-block">Browse creator videos</Link></section>}
    </div>
  );
}
