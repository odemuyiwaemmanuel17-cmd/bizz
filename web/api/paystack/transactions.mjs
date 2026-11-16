import { adminClient, authenticatedUser, json, methodAllowed, sendError } from "../_paystack.mjs";

const SUBSCRIPTION_FIELDS = "id,plan_code,status,current_period_end,cancel_at_period_end,created_at";

function mapSubscription(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    planCode: String(row.plan_code),
    status: String(row.status),
    currentPeriodEnd: typeof row.current_period_end === "string" ? row.current_period_end : null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

export default async function handler(request, response) {
  if (!methodAllowed(request, response, "GET")) return;
  let client;
  try {
    client = adminClient();
    const user = await authenticatedUser(request, client);
    const expiry = await client.rpc("expire_due_creator_subscriptions");
    if (expiry.error) throw new Error(expiry.error.message);
    const nowIso = new Date().toISOString();
    const [transactions, effective, pending, latest] = await Promise.all([
      client.from("payment_transactions").select("id,transaction_kind,status,amount_cents,currency,platform_fee_cents,creator_net_cents,provider,provider_reference,created_at,paid_at,failure_reason,reconciliation_reason").or(`buyer_id.eq.${user.id},creator_id.eq.${user.id}`).order("created_at", { ascending: false }).limit(50),
      client.from("creator_subscriptions").select(SUBSCRIPTION_FIELDS).eq("creator_id", user.id).eq("status", "active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      client.from("creator_subscriptions").select(SUBSCRIPTION_FIELDS).eq("creator_id", user.id).in("status", ["pending", "incomplete"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      client.from("creator_subscriptions").select(SUBSCRIPTION_FIELDS).eq("creator_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    for (const result of [transactions, effective, pending, latest]) {
      if (result.error) throw new Error(result.error.message);
    }
    return json(response, 200, {
      // Only a verified, unexpired, active subscription can be the current plan.
      subscription: mapSubscription(effective.data),
      // Unconfirmed checkout attempts are reported separately, never as a plan.
      pendingCheckout: mapSubscription(pending.data),
      // Latest record gives the UI an explicit label for cancelled / expired /
      // past due / needs-reconciliation subscriptions.
      latestSubscription: mapSubscription(latest.data),
      transactions: (transactions.data ?? []).map((row) => ({
        id: row.id,
        transactionKind: row.transaction_kind,
        status: row.status,
        amountCents: row.amount_cents,
        currency: row.currency,
        platformFeeCents: row.platform_fee_cents,
        creatorNetCents: row.creator_net_cents,
        provider: row.provider,
        providerReference: row.provider_reference,
        createdAt: row.created_at,
        paidAt: row.paid_at,
        failureReason: row.failure_reason,
        reconciliationReason: row.reconciliation_reason,
      })),
    });
  } catch (error) {
    return sendError(response, error, "Payment history could not be loaded.");
  }
}
