import { useEffect, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import {
  formatMinorAmount,
  getMonetizationOverview,
  isActiveSubscription,
  startPaystackCheckout,
  subscriptionStatusLabel,
  verifyPaystackPayment,
  type MonetizationOverview,
  type MonetizationPlan,
} from "../lib/monetization";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function date(value: string | null): string {
  return value === null ? "an unknown date" : new Date(value).toLocaleString();
}

export default function BillingPage(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, status } = useAuth();
  const [data, setData] = useState<MonetizationOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setData(await getMonetizationOverview());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Billing data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (status === "config-missing") {
      setLoading(false);
      return;
    }
    if (!isAuthenticated) {
      const timer = window.setTimeout(() => navigate(`/auth?next=${encodeURIComponent("/dashboard/billing")}`, { replace: true }), 600);
      return () => window.clearTimeout(timer);
    }
    void load();
    return undefined;
  }, [isAuthenticated, navigate, status]);

  useEffect(() => {
    const reference = new URLSearchParams(location.search).get("reference");
    if (!reference || !isAuthenticated) return;
    let active = true;
    setMessage("Confirming your Paystack payment on the server…");
    void verifyPaystackPayment(reference)
      .then(() => {
        if (!active) return;
        setMessage("Payment verified. Your plan appears below once the entitlement record refreshes.");
        return load();
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Payment verification failed.");
      })
      .finally(() => {
        if (active) window.history.replaceState({}, "", "/dashboard/billing");
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, location.search]);

  async function upgrade(plan: MonetizationPlan): Promise<void> {
    setBusy(plan.code);
    setError(null);
    try {
      const checkout = await startPaystackCheckout({ kind: "subscription", planCode: plan.code });
      window.location.assign(checkout.authorizationUrl);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Checkout could not be started.");
      setBusy(null);
    }
  }

  if (status === "config-missing") return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Connect Supabase to use Plans & Billing.</p></main>;
  if (!isAuthenticated || loading) return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Loading your billing records…</p></main>;
  if (error && !data) return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32"><p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p></main>;
  if (!data) return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32"><p className="text-slate-400">Billing is unavailable.</p></main>;

  const paidSubscription = isActiveSubscription(data.subscription) ? data.subscription : null;
  const current = paidSubscription ? data.plans.find((plan) => plan.code === paidSubscription.planCode) : data.plans.find((plan) => plan.code === "free");
  const pendingPlan = data.pendingCheckout ? data.plans.find((plan) => plan.code === data.pendingCheckout?.planCode) : null;
  const lapsed = data.latestSubscription !== null
    && !isActiveSubscription(data.latestSubscription)
    && data.latestSubscription.id !== data.pendingCheckout?.id
    && ["cancelled", "expired", "past_due", "needs_reconciliation", "incomplete"].includes(data.latestSubscription.status)
    ? data.latestSubscription
    : null;
  const lapsedPlan = lapsed ? data.plans.find((plan) => plan.code === lapsed.planCode) : null;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-20 pt-32 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link>
          <p className="mt-5 text-sm font-medium text-cyan-200">Account billing</p>
          <h1 className="mt-1 text-3xl font-black text-white">Plans & Billing</h1>
          <p className="mt-2 text-sm text-slate-400">Only a server-verified Paystack payment grants a paid plan.</p>
        </div>
        <Link to="/pricing" className="btn-glass">Compare plans</Link>
      </div>

      {message && <p role="status" className="mt-5 rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-100">{message}</p>}
      {error && <p role="alert" className="mt-5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>}

      <section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.045] p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Current plan</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black text-white">{current?.name ?? "Free"}</h2>
            <p className="mt-2 text-sm text-slate-400">
              {paidSubscription
                ? `${subscriptionStatusLabel(paidSubscription.status)} subscription · confirmed by Paystack`
                : "Free access is active by default."}
            </p>
          </div>
          {paidSubscription?.currentPeriodEnd && (
            <p className="text-sm text-slate-400">Next renewal or expiry<br /><strong className="text-white">{new Date(paidSubscription.currentPeriodEnd).toLocaleDateString()}</strong></p>
          )}
        </div>
      </section>

      {data.pendingCheckout && (
        <section className="mt-5 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-200">Unconfirmed checkout</p>
              <h2 className="mt-2 text-lg font-bold text-white">{pendingPlan?.name ?? data.pendingCheckout.planCode}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-amber-100/80">
                Status: <strong>{subscriptionStatusLabel(data.pendingCheckout.status)}</strong> · started {date(data.pendingCheckout.createdAt)}.
                Paystack has not confirmed this payment, so no {pendingPlan?.name ?? "paid"} benefits are active.
                Starting a new checkout replaces this attempt and keeps it in your payment history.
              </p>
            </div>
            <span className="rounded-full border border-amber-200/25 px-3 py-1.5 text-xs font-semibold text-amber-100">{subscriptionStatusLabel(data.pendingCheckout.status)}</span>
          </div>
        </section>
      )}

      {lapsed && (
        <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Latest subscription record</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-300">
              {lapsedPlan?.name ?? lapsed.planCode} · <strong>{subscriptionStatusLabel(lapsed.status)}</strong>
              {lapsed.status === "needs_reconciliation" ? " — the Paystack charge needs a manual review and has not granted a plan." : ""}
            </p>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{subscriptionStatusLabel(lapsed.status)}</span>
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-xl font-bold text-white">Upgrade options</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {data.plans.filter((plan) => plan.code !== "free" && plan.active).map((plan) => (
            <article key={plan.code} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
              <h3 className="text-lg font-bold text-white">{plan.name}</h3>
              <p className="mt-1 text-sm text-slate-400">{plan.description}</p>
              <p className="mt-4 text-2xl font-black text-white">
                {plan.priceCents === null ? "Configured by admin" : formatMinorAmount(plan.priceCents, plan.currency ?? "NGN")}
                <span className="text-xs text-slate-500"> / {plan.billingInterval}</span>
              </p>
              {plan.code === paidSubscription?.planCode ? (
                <p className="mt-5 text-sm font-semibold text-emerald-200">Current plan — active until it expires</p>
              ) : (
                <button type="button" disabled={busy !== null} onClick={() => void upgrade(plan)} className="btn-primary mt-5 disabled:opacity-50">
                  {busy === plan.code ? "Opening Paystack…" : "Upgrade"}
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
        <h2 className="text-lg font-bold text-white">Payment history</h2>
        {data.transactions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No payment transactions recorded.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {data.transactions.map((transaction) => (
              <li key={transaction.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 px-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-white">{label(transaction.transactionKind)}</p>
                  <p className="mt-1 text-xs text-slate-500">{new Date(transaction.createdAt).toLocaleString()} · {formatMinorAmount(transaction.amountCents, transaction.currency)}</p>
                  {transaction.status === "needs_reconciliation" && (
                    <p className="mt-1 text-xs text-amber-200">Paystack payment needs manual reconciliation. No plan has been granted.</p>
                  )}
                </div>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-300">{label(transaction.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
