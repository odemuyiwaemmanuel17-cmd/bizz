import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { creatorProfilePath } from "../lib/creator";
import { isCurrentVerificationAdmin, listAdminVerificationRequests, pendingVerificationCount, type AdminVerificationSummary, type VerificationStatus } from "../lib/verification";

type QueueFilter = VerificationStatus | "all";

const FILTERS: ReadonlyArray<{ value: QueueFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "more_info_required", label: "More information required" },
];

function statusLabel(status: VerificationStatus): string {
  return status === "more_info_required" ? "More information required" : status.charAt(0).toUpperCase() + status.slice(1);
}

function categoryLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AdminVerificationQueuePage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status } = useAuth();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AdminVerificationSummary[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "config-missing") { setLoading(false); return; }
    if (!isAuthenticated) { const timer = window.setTimeout(() => navigate(`/auth?next=${encodeURIComponent("/admin/verification")}`, { replace: true }), 500); return () => window.clearTimeout(timer); }
    let active = true;
    void isCurrentVerificationAdmin().then((allowed) => { if (active) setAdmin(allowed); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Administrator access could not be checked."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAuthenticated, navigate, status]);

  async function loadQueue(): Promise<void> {
    if (admin !== true) return;
    setLoading(true); setError(null);
    try {
      const [nextRows, nextCount] = await Promise.all([listAdminVerificationRequests(filter, search), pendingVerificationCount()]);
      setRows(nextRows); setPendingCount(nextCount);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Verification queue could not be loaded."); } finally { setLoading(false); }
  }

  useEffect(() => { if (admin === true) void loadQueue(); }, [admin, filter, search]);

  function submitSearch(event: FormEvent): void { event.preventDefault(); setSearch(searchInput.trim()); }

  if (status === "config-missing") return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32"><section className="glass rounded-3xl p-8 text-center"><h1 className="text-2xl font-bold text-white">Verification administration unavailable</h1><p className="mt-2 text-sm text-slate-400">Connect Supabase and apply the creator verification admin migration.</p></section></main>;
  if (!isAuthenticated || loading && admin === null) return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Checking administrator access…</p></main>;
  if (admin !== true) return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32"><section className="glass rounded-3xl p-8 text-center"><h1 className="text-2xl font-bold text-white">Not authorized</h1><p className="mt-2 text-sm text-slate-400">This area is restricted to explicitly authorized verification administrators.</p></section></main>;

  return <main className="mx-auto max-w-6xl px-4 pb-20 pt-32">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-violet-200">Administrator workspace</p><h1 className="mt-1 text-3xl font-black text-white">Creator verification</h1><p className="mt-2 text-sm text-slate-400">Review submitted identity, business, professional, and creator evidence.</p></div><div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-center"><p className="text-2xl font-black text-cyan-100">{pendingCount}</p><p className="text-xs uppercase tracking-wider text-cyan-200">Pending</p></div></div>
    <div className="mt-7 flex flex-wrap gap-2">{FILTERS.map((item) => <button key={item.value} type="button" onClick={() => setFilter(item.value)} className={`rounded-full px-3 py-2 text-xs font-semibold transition ${filter === item.value ? "bg-violet-500 text-white" : "border border-white/10 bg-white/5 text-slate-300 hover:text-white"}`}>{item.label}</button>)}</div>
    <form onSubmit={submitSearch} className="mt-5 flex flex-col gap-2 sm:flex-row"><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search creator name, username, or application ID" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-slate-500" /><button type="submit" className="btn-primary">Search</button>{search && <button type="button" onClick={() => { setSearchInput(""); setSearch(""); }} className="btn-glass">Clear</button>}</form>
    {error && <p role="alert" className="mt-5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>}
    {loading && <p className="mt-8 text-sm text-slate-400">Loading applications…</p>}
    {!loading && !error && rows.length === 0 && <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/5 p-10 text-center"><p className="text-lg font-semibold text-white">No applications found</p><p className="mt-2 text-sm text-slate-400">Try another status or search term.</p></div>}
    {!loading && rows.length > 0 && <div className="mt-6 overflow-hidden rounded-2xl border border-white/10"><div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 bg-white/5 px-4 py-3 text-xs uppercase tracking-wider text-slate-500 md:grid"><span>Creator</span><span>Category</span><span>Submitted</span><span>Status</span></div><ul className="divide-y divide-white/10">{rows.map((row) => <li key={row.id} className="grid gap-3 bg-black/10 px-4 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-4"><div className="min-w-0"><div className="flex items-center gap-3"><div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-white/10">{row.avatarUrl ? <img src={row.avatarUrl} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center text-sm font-bold text-white">{row.creatorName.charAt(0).toUpperCase()}</span>}</div><div className="min-w-0"><Link to={creatorProfilePath(row.creatorUsername, row.creatorId)} className="truncate font-semibold text-white hover:text-cyan-200">{row.creatorName}</Link><p className="truncate text-xs text-slate-500">@{row.creatorUsername ?? "unknown"}</p></div></div><p className="mt-2 truncate font-mono text-[11px] text-slate-600">{row.id}</p></div><p className="text-sm text-slate-300">{categoryLabel(row.verificationCategory)}</p><p className="text-sm text-slate-400">{formatDate(row.createdAt)}</p><div className="flex items-center justify-between gap-3 md:justify-end"><span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{statusLabel(row.status)}</span><Link to={`/admin/verification/${row.id}`} className="btn-glass px-3 py-1.5 text-xs">Review</Link></div></li>)}</ul></div>}
  </main>;
}
