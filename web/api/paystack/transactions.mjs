import { adminClient, authenticatedUser, json, methodAllowed } from "../_paystack.mjs";

export default async function handler(request, response) {
  if (!methodAllowed(request, response, "GET")) return;
  const client = adminClient();
  try {
    const user = await authenticatedUser(request, client);
    const expiry = await client.rpc("expire_due_creator_subscriptions");
    if (expiry.error) throw new Error(expiry.error.message);
    const [transactions, subscription] = await Promise.all([
      client.from("payment_transactions").select("id,transaction_kind,status,amount_cents,currency,platform_fee_cents,creator_net_cents,provider,provider_reference,created_at,paid_at,failure_reason").or(`buyer_id.eq.${user.id},creator_id.eq.${user.id}`).order("created_at", { ascending: false }).limit(50),
      client.from("creator_subscriptions").select("id,plan_code,status,current_period_end,cancel_at_period_end").eq("creator_id", user.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (transactions.error) throw new Error(transactions.error.message);
    if (subscription.error) throw new Error(subscription.error.message);
    return json(response, 200, {
      subscription: subscription.data,
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
      })),
    });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "Payment history could not be loaded." });
  }
}
