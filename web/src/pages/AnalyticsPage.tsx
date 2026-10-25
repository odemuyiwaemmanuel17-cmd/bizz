import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import {
  bizzClickThroughRate,
  engagementRate,
  fetchCreatorAnalytics,
  type AnalyticsRange,
  type CreatorAnalytics,
} from "../lib/analytics";

const RANGE_OPTIONS: ReadonlyArray<{ readonly id: AnalyticsRange; readonly label: string }> = [
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
  { id: "all", label: "All time" },
];

const EMPTY: CreatorAnalytics = {
  totals: { videoViews: 0, profileVisits: 0, bizzViews: 0, videoToBizzClicks: 0, contactClicks: 0, likes: 0, saves: 0 },
  trends: [],
  topVideos: [],
  topBizzes: [],
};

function Metric({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint: string }): ReactElement {
  return <article className="rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-xs uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-3xl font-black tabular-nums text-white">{value}</p><p className="mt-1 text-xs text-slate-500">{hint}</p></article>;
}

function percent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export default function AnalyticsPage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status, user } = useAuth();
  const [range, setRange] = useState<AnalyticsRange>(30);
  const [data, setData] = useState<CreatorAnalytics>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) {
      setLoading(status !== "config-missing");
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void fetchCreatorAnalytics(user.id, range).then((result) => {
      if (!active) return;
      if (result.ok) setData(result.data);
      else setError(result.message);
      setLoading(false);
    });
    return () => { active = false; };
  }, [range, status, user]);

  if (status !== "config-missing" && !isAuthenticated && user === null) {
    return <main className="mx-auto max-w-xl px-4 pb-20 pt-32 text-center"><section className="glass rounded-3xl p-8"><h1 className="text-xl font-bold text-white">Creator analytics 🔒</h1><p className="mt-2 text-sm text-slate-400">Sign in to view private performance metrics for your own content.</p><Link to="/auth" className="btn-primary mt-5 inline-block">Go to sign in</Link></section></main>;
  }

  if (status === "config-missing") {
    return <main className="mx-auto max-w-xl px-4 pb-20 pt-32 text-center"><section className="glass rounded-3xl p-8"><h1 className="text-xl font-bold text-white">Analytics unavailable</h1><p className="mt-2 text-sm text-slate-400">Connect Supabase to record and view real creator activity.</p></section></main>;
  }

  const totals = data.totals;
  const maxTrend = Math.max(1, ...data.trends.map((item) => Math.max(item.videoViews, item.profileVisits, item.bizzViews, item.contactClicks)));
  const hasActivity = totals.videoViews + totals.profileVisits + totals.bizzViews + totals.videoToBizzClicks + totals.contactClicks + totals.likes + totals.saves > 0;

  return <main className="mx-auto max-w-6xl px-4 pb-20 pt-28 sm:px-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link><p className="mt-4 text-sm font-semibold uppercase tracking-[0.25em] text-cyan-300">Private creator tools</p><h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">Analytics</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Real activity from your published videos, profile, Bizzes, and contact actions. Tracking begins after the Phase 6 migration is applied.</p></div>
      <div className="flex flex-wrap gap-2 rounded-2xl bg-white/5 p-1">{RANGE_OPTIONS.map((item) => <button key={String(item.id)} type="button" onClick={() => setRange(item.id)} className={`rounded-xl px-3 py-2 text-xs font-semibold ${range === item.id ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>{item.label}</button>)}</div>
    </div>

    {error !== null && <div role="alert" className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}<button type="button" onClick={() => navigate("/dashboard")} className="ml-3 underline">Back to dashboard</button></div>}
    {loading ? <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">Loading your analytics…</div> : <>
      <section aria-label="Analytics summary" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Video views" value={totals.videoViews.toLocaleString("en-US")} hint="Tracked published-video views" /><Metric label="Profile visits" value={totals.profileVisits.toLocaleString("en-US")} hint="Public profile views" /><Metric label="Bizz views" value={totals.bizzViews.toLocaleString("en-US")} hint="Active listing detail views" /><Metric label="Contact clicks" value={totals.contactClicks.toLocaleString("en-US")} hint="Potential customer intent" /></section>
      <section className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Likes" value={totals.likes.toLocaleString("en-US")} hint="Current video likes" /><Metric label="Saves" value={totals.saves.toLocaleString("en-US")} hint="Current saved-video records" /><Metric label="Video → Bizz clicks" value={totals.videoToBizzClicks.toLocaleString("en-US")} hint="Linked Bizz opens from videos" /><Metric label="Engagement rate" value={percent(engagementRate(totals))} hint="(likes + saves) ÷ video views" /></section>

      {!hasActivity && <section className="mt-8 rounded-3xl border border-dashed border-white/15 bg-white/5 p-10 text-center"><h2 className="text-lg font-semibold text-white">No tracked activity yet</h2><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-400">Publish a video or Bizz and share your profile. Older activity is not reconstructed because it was not tracked before Phase 6.</p><Link to="/discover" className="btn-primary mt-5 inline-block">Explore Discover</Link></section>}

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]"><article className="rounded-3xl border border-white/10 bg-white/5 p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-bold text-white">Performance trend</h2><p className="mt-1 text-xs text-slate-500">Days with recorded activity only</p></div><p className="text-xs text-slate-500">Bizz CTR: {percent(bizzClickThroughRate(totals))}</p></div>{data.trends.length === 0 ? <p className="mt-8 text-sm text-slate-500">No trend data for this range.</p> : <div className="mt-5 space-y-3">{data.trends.map((item) => <div key={item.date} className="grid grid-cols-[78px_1fr_42px] items-center gap-3 text-xs"><time className="text-slate-500">{item.date}</time><div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500" style={{ width: `${Math.max(3, (item.videoViews / maxTrend) * 100)}%` }} /></div><span className="text-right tabular-nums text-slate-300">{item.videoViews}</span></div>)}</div>}</article><article className="rounded-3xl border border-white/10 bg-white/5 p-5"><h2 className="text-lg font-bold text-white">What the numbers mean</h2><ul className="mt-4 space-y-3 text-sm leading-6 text-slate-400"><li><strong className="text-slate-200">Views</strong> count deduplicated events within a 30-minute browser session window.</li><li><strong className="text-slate-200">Engagement</strong> uses current likes and saves divided by tracked video views; zero views safely returns 0%.</li><li><strong className="text-slate-200">Contact clicks</strong> indicate interest, not a confirmed message, sale, or revenue.</li><li><strong className="text-slate-200">History</strong> starts when the analytics migration is applied; previous activity cannot be reconstructed.</li></ul></article></section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2"><article className="rounded-3xl border border-white/10 bg-white/5 p-5"><h2 className="text-lg font-bold text-white">Top videos</h2>{data.topVideos.length === 0 ? <p className="mt-5 text-sm text-slate-500">No published videos yet.</p> : <div className="mt-4 space-y-3">{data.topVideos.map((item) => <Link key={item.id} to={`/dashboard/videos#video-${item.id}`} className="flex gap-3 rounded-2xl border border-white/10 bg-black/10 p-3 transition hover:border-cyan-300/30"><div className="h-16 w-24 shrink-0 overflow-hidden rounded-xl bg-black">{item.videoUrl && <video src={item.videoUrl} muted preload="metadata" className="h-full w-full object-cover" />}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">{item.title}</p><p className="mt-1 text-xs text-slate-500">{item.views} views · {item.likes} likes · {item.saves} saves</p><p className="mt-1 text-xs text-cyan-200">{item.bizzClicks} linked Bizz clicks</p></div></Link>)}</div>}</article><article className="rounded-3xl border border-white/10 bg-white/5 p-5"><h2 className="text-lg font-bold text-white">Top Bizzes</h2>{data.topBizzes.length === 0 ? <p className="mt-5 text-sm text-slate-500">No active Bizzes yet.</p> : <div className="mt-4 space-y-3">{data.topBizzes.map((item) => <Link key={item.id} to={`/listing/${item.id}`} className="flex gap-3 rounded-2xl border border-white/10 bg-black/10 p-3 transition hover:border-cyan-300/30"><div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-violet-500/20">{item.imageUrl && <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">{item.title}</p><p className="mt-1 text-xs text-slate-500">{item.views} views · {item.videoClicks} video clicks</p><p className="mt-1 text-xs text-cyan-200">{item.contactClicks} contact clicks</p></div></Link>)}</div>}</article></section>
    </>}
  </main>;
}
