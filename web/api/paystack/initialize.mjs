import { adminClient, authenticatedUser, enabledConfig, json, methodAllowed, paystackRequest, publicAppUrl, reference, requestBody } from "../_paystack.mjs";

export default async function handler(request, response) {
  if (!methodAllowed(request, response)) return;
  const client = adminClient();
  try {
    const user = await authenticatedUser(request, client);
    const body = requestBody(request);
    const kind = body.kind === "promotion" ? "promotion" : "subscription";
    await enabledConfig(client, kind === "subscription" ? "subscriptions_enabled" : "paid_promotions_enabled");
    const checkoutReference = reference(kind);
    let amount;
    let currency;
    let metadata;

    if (kind === "subscription") {
      const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
      const planResult = await client.from("monetization_plans").select("code,name,price_cents,currency,billing_interval,active,paystack_plan_code").eq("code", planCode).eq("active", true).single();
      if (planResult.error || !planResult.data || planResult.data.code === "free" || planResult.data.price_cents === null) throw new Error("This subscription plan is unavailable.");
      const plan = planResult.data;
      amount = Number(plan.price_cents);
      currency = plan.currency;
      const subscription = await client.from("creator_subscriptions").insert({ creator_id: user.id, plan_code: plan.code, status: "pending", provider: "paystack" }).select("id").single();
      if (subscription.error || !subscription.data) throw new Error(subscription.error?.message || "Subscription could not be prepared.");
      metadata = { hustlehub_kind: "subscription", user_id: user.id, subscription_id: subscription.data.id, plan_code: plan.code, billing_interval: plan.billing_interval };
      const transaction = await client.from("payment_transactions").insert({ buyer_id: user.id, creator_id: user.id, transaction_kind: "subscription", status: "pending", amount_cents: amount, currency, platform_fee_cents: 0, creator_net_cents: 0, provider: "paystack", provider_reference: checkoutReference, idempotency_key: checkoutReference, metadata }).select("id").single();
      if (transaction.error || !transaction.data) throw new Error(transaction.error?.message || "Payment transaction could not be prepared.");
      metadata.transaction_id = transaction.data.id;
      if (plan.paystack_plan_code) metadata.paystack_plan_code = plan.paystack_plan_code;
      const payload = { email: user.email, amount: String(amount), currency, reference: checkoutReference, callback_url: `${publicAppUrl()}/dashboard/billing?reference=${encodeURIComponent(checkoutReference)}`, metadata: JSON.stringify(metadata) };
      if (plan.paystack_plan_code) payload.plan = plan.paystack_plan_code;
      try {
        const checkout = await paystackRequest("/transaction/initialize", { method: "POST", body: JSON.stringify(payload) });
        return json(response, 200, { authorizationUrl: checkout.authorization_url, reference: checkout.reference });
      } catch (error) {
        await client.from("payment_transactions").update({ status: "failed", failure_reason: error instanceof Error ? error.message : "Paystack initialization failed." }).eq("provider_reference", checkoutReference);
        throw error;
      }
    }

    const packageId = typeof body.packageId === "string" ? body.packageId.trim() : "";
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    const packageResult = await client.from("promotion_packages").select("id,name,price_cents,currency,duration_days,active").eq("id", packageId).eq("active", true).single();
    if (packageResult.error || !packageResult.data || !targetId) throw new Error("This promotion package is unavailable.");
    const packageRow = packageResult.data;
    const listing = await client.from("listings").select("id,user_id,status").eq("id", targetId).eq("user_id", user.id).eq("status", "active").maybeSingle();
    if (listing.error || !listing.data) throw new Error("Only your active Bizz listings can be promoted.");
    amount = Number(packageRow.price_cents);
    currency = packageRow.currency;
    const order = await client.from("promotion_orders").insert({ creator_id: user.id, target_type: "listing", listing_id: targetId, package_id: packageId, status: "pending_payment", amount_cents: amount, currency }).select("id").single();
    if (order.error || !order.data) throw new Error(order.error?.message || "Promotion order could not be prepared.");
    metadata = { hustlehub_kind: "promotion", user_id: user.id, promotion_order_id: order.data.id, package_id: packageId, listing_id: targetId };
    const transaction = await client.from("payment_transactions").insert({ buyer_id: user.id, creator_id: user.id, transaction_kind: "promotion", status: "pending", amount_cents: amount, currency, platform_fee_cents: amount, creator_net_cents: 0, provider: "paystack", provider_reference: checkoutReference, idempotency_key: checkoutReference, metadata }).select("id").single();
    if (transaction.error || !transaction.data) throw new Error(transaction.error?.message || "Payment transaction could not be prepared.");
    await client.from("promotion_orders").update({ transaction_id: transaction.data.id }).eq("id", order.data.id);
    try {
      const checkout = await paystackRequest("/transaction/initialize", { method: "POST", body: JSON.stringify({ email: user.email, amount: String(amount), currency, reference: checkoutReference, callback_url: `${publicAppUrl()}/dashboard/promotions?reference=${encodeURIComponent(checkoutReference)}`, metadata: JSON.stringify(metadata) }) });
      return json(response, 200, { authorizationUrl: checkout.authorization_url, reference: checkout.reference });
    } catch (error) {
      await client.from("payment_transactions").update({ status: "failed", failure_reason: error instanceof Error ? error.message : "Paystack initialization failed." }).eq("provider_reference", checkoutReference);
      await client.from("promotion_orders").update({ status: "failed" }).eq("id", order.data.id);
      throw error;
    }
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "Checkout could not be initialized." });
  }
}
