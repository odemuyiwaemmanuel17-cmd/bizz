import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { formatMinorAmount, getAdminRevenueSummary, type AdminRevenueSummary } from "../lib/monetization";
import { isCurrentVerificationAdmin } from "../lib/verification";

function RevenueCard({ label, cents, currency = "USD", hint }: { readonly label: string; readonly cents: number; readonly currency?: string; readonly hint: string }): ReactElement {
  return <article className="rounded-2xl border border-white/10 bg-white/[0.045] p-5"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{label}</p><p className="mt-3 text-2xl font-black text-white">{formatMinorAmount(cents, currency)}</p><p className="mt-2 text-xs leading-5 text-slate-500">{hint}</p></article>;
}

export default function AdminRevenuePage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status } = useAuth();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<AdminRevenueSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "config-missing") { setLoading(false); return; }
    if (!isAuthenticated) { const timer = window.setTimeout(() => navigate(`/auth?next=${encodeURIComponent("/admin/revenue")}`, { replace: true }), 500); return () => window.clearTimeout(timer); }
    let active = true;
    void isCurrentVerificationAdmin().then((allowed) => {
      if (!active) return;
      setAdmin(allowed);
      if (!allowed) { setLoading(false); return; }
      return getAdminRevenueSummary().then((data) => { if (active) setSummary(data); });
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Revenue data could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAuthenticated, navigate, status]);

  if (status === "config-missing") return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Connect Supabase to use the revenue dashboard.</p></main>;
  if (!isAuthenticated || admin === null || loading) return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Checking administrator access…</p></main>;
  if (admin !== true) return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32 text-center"><h1 className="text-2xl font-bold text-white">Not authorized</h1><p className="mt-2 text-sm text-slate-400">Financial reporting is restricted to authorized administrators.</p></main>;
  if (error !== null || summary === null) return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32"><p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error ?? "Revenue data could not be loaded."}</p><Link to="/admin/verification" className="btn-glass mt-5 inline-block">Back to admin</Link></main>;

  return <main className="mx-auto max-w-6xl px-4 pb-20 pt-32 sm:px-6"><div className="flex flex-wrap items-end justify-between gap-4"><div><Link to="/admin/verification" className="text-sm text-slate-400 hover:text-white">← Verification admin</Link><p className="mt-5 text-sm font-medium text-cyan-200">Administrator workspace</p><h1 className="mt-1 text-3xl font-black text-white">Revenue</h1><p className="mt-2 text-sm text-slate-400">Confirmed payment records only. Amounts remain in their original transaction currency.</p></div><span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100">No simulated revenue</span></div><section className="mt-8 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Successful transactions</p><p className="mt-3 text-2xl font-black text-emerald-200">{summary.successfulTransactionCount}</p><p className="mt-2 text-xs text-slate-500">Across {summary.byCurrency.length} recorded currency{summary.byCurrency.length === 1 ? "" : "ies"}.</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Pending payouts</p><p className="mt-3 text-2xl font-black text-amber-200">{summary.pendingPayoutsCents.toLocaleString("en-US")} minor units</p><p className="mt-2 text-xs text-slate-500">Original currencies are listed below; no conversion is applied.</p></div><div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Failed payments</p><p className="mt-3 text-2xl font-black text-rose-200">{summary.failedPaymentCount}</p><p className="mt-2 text-xs text-slate-500">Recorded failed payment transactions.</p></div></section><section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5"><h2 className="text-lg font-bold text-white">Confirmed amounts by currency</h2>{summary.byCurrency.length === 0 ? <p className="mt-4 text-sm text-slate-500">No payment transactions have been confirmed.</p> : <div className="mt-4 grid gap-3 md:grid-cols-2">{summary.byCurrency.map((currency) => <article key={currency.currency} className="rounded-xl border border-white/10 bg-black/10 p-4"><div className="flex items-center justify-between"><h3 className="font-semibold text-white">{currency.currency}</h3><span className="text-xs text-slate-500">Original currency</span></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><RevenueCard label="Gross" cents={currency.grossCents} currency={currency.currency} hint="Succeeded" /><RevenueCard label="Platform fees" cents={currency.platformFeesCents} currency={currency.currency} hint="Recorded" /><RevenueCard label="Promotions" cents={currency.promotionCents} currency={currency.currency} hint="Succeeded" /><RevenueCard label="Subscriptions" cents={currency.subscriptionCents} currency={currency.currency} hint="Succeeded" /></div><p className="mt-3 text-xs text-slate-500">Marketplace: {formatMinorAmount(currency.marketplaceCents, currency.currency)} · Refunded: {formatMinorAmount(currency.refundedCents, currency.currency)}</p></article>)}</div>}</section></main>;
}
