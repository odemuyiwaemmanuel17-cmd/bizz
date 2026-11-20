import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import {
  formatMinorAmount,
  getMonetizationOverview,
  isActiveSubscription,
  requestSubscriptionManageLink,
  startPaystackCheckout,
  subscriptionStatusLabel,
  verifyPaystackPayment,
  type MonetizationOverview,
  type MonetizationPlan,
} from "../lib/monetization";

/** Set immediately before handing the user to Paystack, so their return can be explained. */
const CANCELLATION_RETURN_KEY = "hustlehub:cancellation-return";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function date(value: string | null): string {
  return value === null ? "an unknown date" : new Date(value).toLocaleString();
}

function planAmount(plan: MonetizationPlan | null): string {
  if (plan === null || plan.priceCents === null) return "Configured by admin";
  const amount = formatMinorAmount(plan.priceCents, plan.currency ?? "NGN");
  return plan.billingInterval === null ? amount : `${amount} / ${plan.billingInterval}`;
}

interface CancelDialogProps {
  readonly planName: string;
  readonly paidThrough: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onKeep: () => void;
  readonly onContinue: () => void;
}

function CancelDialog({ planName, paidThrough, busy, error, onKeep, onContinue }: CancelDialogProps): ReactElement {
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) onKeep();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onKeep]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-subscription-title"
      aria-describedby="cancel-subscription-body"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onKeep();
      }}
    >
      <div className="glass w-full max-w-lg rounded-t-3xl p-6 sm:rounded-3xl sm:p-8">
        <h2 id="cancel-subscription-title" className="text-xl font-bold text-white">Cancel your subscription?</h2>
        <div id="cancel-subscription-body" className="mt-3 space-y-3 text-sm leading-6 text-slate-300">
          <p>
            You will stop future automatic renewals of <strong className="text-white">{planName}</strong>.
            Your current paid benefits stay available until the end of your billing period
            {paidThrough === null ? "" : <> (paid through <strong className="text-white">{new Date(paidThrough).toLocaleDateString()}</strong>)</>},
            provided Paystack confirms the cancellation and the subscription remains active.
          </p>
          <p>You will not automatically receive a refund for payments already made.</p>
          <p className="text-slate-400">
            Cancellation is completed on Paystack&apos;s own subscription page. Nothing changes until Paystack confirms it here.
          </p>
        </div>
        {error !== null && (
          <p role="alert" className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button ref={keepRef} type="button" onClick={onKeep} disabled={busy} className="btn-glass disabled:opacity-50">
            Keep Subscription
          </button>
          <button
            type="button"
            onClick={onContinue}
            disabled={busy}
            aria-busy={busy}
            className="rounded-xl border border-rose-400/40 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-50 transition hover:bg-rose-500/30 disabled:opacity-60"
          >
            {busy ? "Opening Paystack…" : "Continue to Cancellation"}
          </button>
        </div>
      </div>
    </div>
  );
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
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

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

  // Returning from Paystack is not proof of cancellation: the webhook decides.
  useEffect(() => {
    if (data === null) return;
    let returning = false;
    try {
      returning = window.sessionStorage.getItem(CANCELLATION_RETURN_KEY) === "1";
      if (returning) window.sessionStorage.removeItem(CANCELLATION_RETURN_KEY);
    } catch {
      returning = false;
    }
    if (!returning) return;
    const subscription = data.subscription;
    if (subscription !== null && subscription.cancelAtPeriodEnd) {
      setAwaitingConfirmation(false);
      setMessage("Paystack confirmed the cancellation. Automatic renewal has stopped and your benefits remain until the paid-through date below.");
    } else if (subscription !== null) {
      setAwaitingConfirmation(true);
      setMessage("Awaiting Paystack's confirmation. If you completed the cancellation, this page updates once their webhook arrives; nothing has changed yet.");
    }
  }, [data]);

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

  function openCancelDialog(): void {
    setCancelError(null);
    setCancelling(false);
    setCancelOpen(true);
  }

  function closeCancelDialog(): void {
    if (cancelling) return;
    setCancelOpen(false);
    setCancelError(null);
  }

  async function continueCancellation(): Promise<void> {
    if (paidSubscription === null || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const link = await requestSubscriptionManageLink(paidSubscription.id);
      try {
        window.sessionStorage.setItem(CANCELLATION_RETURN_KEY, "1");
      } catch {
        // A blocked sessionStorage only costs the return explanation.
      }
      window.location.assign(link.managementUrl);
    } catch (cause: unknown) {
      setCancelError(cause instanceof Error ? cause.message : "Your subscription could not be opened in Paystack. Nothing has changed.");
      setCancelling(false);
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
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Current plan</p>
          {paidSubscription?.cancelAtPeriodEnd === true && (
            <span className="rounded-full border border-amber-200/25 bg-amber-300/10 px-3 py-1 text-xs font-semibold text-amber-100">
              Renewal cancelled
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black text-white">{current?.name ?? "Free"}</h2>
            <p className="mt-2 text-sm text-slate-400">
              {paidSubscription
                ? `${subscriptionStatusLabel(paidSubscription.status)} subscription · confirmed by Paystack`
                : "Free access is active by default."}
            </p>
            {paidSubscription && (
              <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-slate-500">Billing</dt>
                  <dd className="text-slate-200">{planAmount(current ?? null)}</dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-slate-500">Status</dt>
                  <dd className="text-slate-200">{subscriptionStatusLabel(paidSubscription.status)}</dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-slate-500">Paid through</dt>
                  <dd className="text-slate-200">{paidSubscription.currentPeriodEnd === null ? "Open-ended" : new Date(paidSubscription.currentPeriodEnd).toLocaleDateString()}</dd>
                </div>
                <div className="flex justify-between gap-4 sm:block">
                  <dt className="text-slate-500">{paidSubscription.cancelAtPeriodEnd ? "Ends" : "Next renewal"}</dt>
                  <dd className="text-slate-200">{paidSubscription.currentPeriodEnd === null ? "Not scheduled" : new Date(paidSubscription.currentPeriodEnd).toLocaleDateString()}</dd>
                </div>
              </dl>
            )}
          </div>
          {paidSubscription?.cancellable === true && (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <button type="button" onClick={openCancelDialog} className="btn-glass border-amber-200/30 text-amber-100">
                {paidSubscription.cancelAtPeriodEnd ? "Manage subscription" : "Cancel Subscription"}
              </button>
              <p className="max-w-xs text-xs leading-5 text-slate-500">
                Cancellation is completed on Paystack. Your plan stays active until the paid-through date.
              </p>
            </div>
          )}
        </div>
        {awaitingConfirmation && (
          <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
            No cancellation has been confirmed by Paystack yet. If you completed it on their page, it can take a moment to reach us; refresh this page shortly.
          </p>
        )}
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

      {cancelOpen && paidSubscription !== null && (
        <CancelDialog
          planName={current?.name ?? paidSubscription.planCode}
          paidThrough={paidSubscription.currentPeriodEnd}
          busy={cancelling}
          error={cancelError}
          onKeep={closeCancelDialog}
          onContinue={() => void continueCancellation()}
        />
      )}
    </main>
  );
}
