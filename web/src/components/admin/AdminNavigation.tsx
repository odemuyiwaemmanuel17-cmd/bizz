import { useState, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";

interface AdminNavigationProps { readonly current?: string; }

const ITEMS = [
  ["Overview", "/admin", "overview"], ["Users & Creators", "/admin?section=users", "users"],
  ["Creator Verification", "/admin/verification", "verification"], ["Videos", "/admin?section=videos", "videos"],
  ["Bizzes & Listings", "/admin?section=listings", "listings"], ["Ideas & Validation", "/admin?section=ideas", "ideas"],
  ["Community & Engagement", "/admin?section=community", "community"], ["Promotions & Campaigns", "/admin?section=promotions", "promotions"],
  ["Payments & Monetization", "/admin/revenue", "revenue"], ["Reports & Moderation", "/admin?section=reports", "reports"],
  ["Audit Logs", "/admin?section=audit", "audit"], ["Settings", "/admin?section=settings", "settings"],
] as const;

export default function AdminNavigation({ current }: AdminNavigationProps): ReactElement {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const querySection = new URLSearchParams(location.search).get("section") ?? "overview";
  const active = current ?? (location.pathname === "/admin/verification" ? "verification" : location.pathname === "/admin/revenue" ? "revenue" : querySection);
  const activeLabel = ITEMS.find((item) => item[2] === active)?.[0] ?? "Overview";
  return <aside className="min-w-0 lg:sticky lg:top-28 lg:self-start"><button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center justify-between rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-left text-sm font-semibold text-cyan-100 lg:hidden"><span>Admin: {activeLabel}</span><span>{open ? "−" : "+"}</span></button><nav aria-label="Admin sections" className={`${open ? "mt-3 block" : "hidden"} rounded-2xl border border-white/10 bg-slate-950/80 p-3 lg:mt-0 lg:block lg:border-0 lg:bg-transparent lg:p-0`}><p className="mb-3 px-3 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-300/70">Admin Control Center</p><div className="space-y-1">{ITEMS.map(([label, to, id]) => <Link key={id} to={to} onClick={() => setOpen(false)} className={`block rounded-xl px-3 py-2.5 text-sm transition ${active === id ? "bg-violetGlow/25 font-semibold text-white ring-1 ring-violetGlow/30" : "text-slate-400 hover:bg-white/5 hover:text-white"}`} aria-current={active === id ? "page" : undefined}>{label}</Link>)}</div></nav></aside>;
}
