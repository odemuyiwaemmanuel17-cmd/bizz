import { adminClient, authenticatedUser, checkoutKind, enabledConfig, json, methodAllowed, paystackPublicKey, paystackRequest, publicAppUrl, reference, requestBody, selectCheckoutAction, sendError } from "../_paystack.mjs";

async function initializePaystack(payload) {
  try {
    return await paystackRequest("/transaction/initialize", { method: "POST", body: JSON.stringify(payload) });
  } catch (error) {
    // Provider faults are distinct from invalid user input and must not be
    // reported as 400s: they require operator attention.
    throw Object.assign(new Error(error instanceof Error ? error.message : "Paystack checkout could not be initialized."), { providerFailure: true });
  }
}

export default async function handler(request, response) {
  if (!methodAllowed(request, response)) return;
  let client;
  try {
    client = adminClient();
    const user = await authenticatedUser(request, client);
    const body = requestBody(request);
    const kind = checkoutKind(body.kind);
    await enabledConfig(client, kind === "subscription" ? "subscriptions_enabled" : "paid_promotions_enabled");
    const appUrl = publicAppUrl();
    if (!appUrl) throw Object.assign(new Error("PUBLIC_APP_URL is not configured on the server."), { configurationFailure: true });
    if (typeof user.email !== "string" || user.email.length === 0) throw Object.assign(new Error("Your account does not have an email address for Paystack checkout."), { validationFailure: true });
    const checkoutReference = reference(kind);
    let amount;
    let currency;
    let metadata;

    if (kind === "subscription") {
      const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
      const planResult = await client.from("monetization_plans").select("code,name,price_cents,currency,billing_interval,active,paystack_plan_code").eq("code", planCode).eq("active", true).single();
      if (planResult.error || !planResult.data || planResult.data.code === "free" || planResult.data.price_cents === null) throw Object.assign(new Error("This subscription plan is unavailable."), { validationFailure: true });
      const plan = planResult.data;
      amount = Number(plan.price_cents);
      currency = typeof plan.currency === "string" ? plan.currency.toUpperCase() : "";
      if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency) || (plan.billing_interval !== "month" && plan.billing_interval !== "year") || typeof plan.paystack_plan_code !== "string" || !/^PLN_[A-Za-z0-9]+$/.test(plan.paystack_plan_code)) throw Object.assign(new Error("This plan does not have valid Paystack test-plan configuration."), { validationFailure: true });

      const alreadyActive = await client.from("creator_subscriptions").select("id,status").eq("creator_id", user.id).eq("plan_code", plan.code).in("status", ["active", "past_due"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (alreadyActive.error) throw alreadyActive.error;
      if (alreadyActive.data) throw Object.assign(new Error("You already have this plan. Manage the current subscription from Plans & Billing."), { validationFailure: true });

      const pending = await client.from("creator_subscriptions").select("id,plan_code,status,created_at").eq("creator_id", user.id).in("status", ["pending", "incomplete"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (pending.error) throw pending.error;
      const decision = selectCheckoutAction({ pending: pending.data, planCode: plan.code });
      if (decision.action === "reject") throw Object.assign(new Error(decision.reason), { validationFailure: true });

      // Only one outstanding checkout may exist per user. A superseded attempt
      // is cancelled by the server RPC with an audit trail; no row is deleted.
      if (decision.action === "supersede") {
        const superseded = await client.rpc("supersede_pending_checkout", { p_user_id: user.id, p_reason: decision.reason });
        if (superseded.error) throw superseded.error;
      }

      const subscription = await client.from("creator_subscriptions").insert({ creator_id: user.id, plan_code: plan.code, status: "pending", provider: "paystack", provider_plan_code: plan.paystack_plan_code }).select("id").single();
      if (subscription.error || !subscription.data) throw new Error(subscription.error?.message || "Subscription could not be prepared.");
      metadata = {
        hustlehub_kind: "subscription",
        user_id: user.id,
        subscription_id: subscription.data.id,
        plan_code: plan.code,
        billing_interval: plan.billing_interval,
        paystack_plan_code: plan.paystack_plan_code,
        expected_amount_cents: amount,
        expected_currency: currency,
      };
      const transaction = await client.from("payment_transactions").insert({ buyer_id: user.id, creator_id: user.id, transaction_kind: "subscription", status: "pending", amount_cents: amount, currency, platform_fee_cents: 0, creator_net_cents: 0, provider: "paystack", provider_reference: checkoutReference, idempotency_key: checkoutReference, metadata }).select("id").single();
      if (transaction.error || !transaction.data) {
        await client.from("creator_subscriptions").update({ status: "incomplete", updated_at: new Date().toISOString() }).eq("id", subscription.data.id).eq("status", "pending");
        throw new Error(transaction.error?.message || "Payment transaction could not be prepared.");
      }
      metadata.transaction_id = transaction.data.id;

      // The plan is the only amount authority Paystack is given: sending a
      // separate amount is what allowed a Pro/Business divergence.
      const payload = {
        email: user.email,
        reference: checkoutReference,
        callback_url: `${appUrl}/dashboard/billing?reference=${encodeURIComponent(checkoutReference)}`,
        plan: plan.paystack_plan_code,
        metadata: JSON.stringify(metadata),
      };
      try {
        const checkout = await initializePaystack(payload);
        console.info("[paystack initialize] subscription checkout created", { reference: checkoutReference, planCode: plan.code, providerPlanCode: plan.paystack_plan_code });
        return json(response, 200, { authorizationUrl: checkout.authorization_url, reference: checkout.reference, publicKey: paystackPublicKey() });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Paystack initialization failed.";
        await client.from("payment_transactions").update({ status: "failed", verification_status: "rejected", failure_reason: message, updated_at: new Date().toISOString() }).eq("provider_reference", checkoutReference);
        await client.from("creator_subscriptions").update({ status: "incomplete", updated_at: new Date().toISOString() }).eq("id", subscription.data.id).eq("status", "pending");
        console.error("[paystack initialize] provider rejected subscription checkout", { reference: checkoutReference });
        throw Object.assign(new Error("Paystack checkout could not be initialized. Please try again."), { providerFailure: true });
      }
    }

    const packageId = typeof body.packageId === "string" ? body.packageId.trim() : "";
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    const packageResult = await client.from("promotion_packages").select("id,name,price_cents,currency,duration_days,active").eq("id", packageId).eq("active", true).single();
    if (packageResult.error || !packageResult.data || !targetId) throw Object.assign(new Error("This promotion package is unavailable."), { validationFailure: true });
    const packageRow = packageResult.data;
    const listing = await client.from("listings").select("id,user_id,status").eq("id", targetId).eq("user_id", user.id).eq("status", "active").maybeSingle();
    if (listing.error || !listing.data) throw Object.assign(new Error("Only your active Bizz listings can be promoted."), { validationFailure: true });
    amount = Number(packageRow.price_cents);
    currency = typeof packageRow.currency === "string" ? packageRow.currency.toUpperCase() : "";
    if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error("This promotion package does not have valid payment configuration."), { validationFailure: true });
    const order = await client.from("promotion_orders").insert({ creator_id: user.id, target_type: "listing", listing_id: targetId, package_id: packageId, status: "pending_payment", amount_cents: amount, currency }).select("id").single();
    if (order.error || !order.data) throw new Error(order.error?.message || "Promotion order could not be prepared.");
    metadata = { hustlehub_kind: "promotion", user_id: user.id, promotion_order_id: order.data.id, package_id: packageId, listing_id: targetId };
    const transaction = await client.from("payment_transactions").insert({ buyer_id: user.id, creator_id: user.id, transaction_kind: "promotion", status: "pending", amount_cents: amount, currency, platform_fee_cents: amount, creator_net_cents: 0, provider: "paystack", provider_reference: checkoutReference, idempotency_key: checkoutReference, metadata }).select("id").single();
    if (transaction.error || !transaction.data) throw new Error(transaction.error?.message || "Payment transaction could not be prepared.");
    await client.from("promotion_orders").update({ transaction_id: transaction.data.id }).eq("id", order.data.id);
    try {
      const checkout = await initializePaystack({ email: user.email, amount: String(amount), currency, reference: checkoutReference, callback_url: `${appUrl}/dashboard/promotions?reference=${encodeURIComponent(checkoutReference)}`, metadata: JSON.stringify(metadata) });
      console.info("[paystack initialize] promotion checkout created", { reference: checkoutReference, packageId });
      return json(response, 200, { authorizationUrl: checkout.authorization_url, reference: checkout.reference, publicKey: paystackPublicKey() });
    } catch (error) {
      await client.from("payment_transactions").update({ status: "failed", verification_status: "rejected", failure_reason: error instanceof Error ? error.message : "Paystack initialization failed.", updated_at: new Date().toISOString() }).eq("provider_reference", checkoutReference);
      await client.from("promotion_orders").update({ status: "failed" }).eq("id", order.data.id);
      console.error("[paystack initialize] provider rejected promotion checkout", { reference: checkoutReference });
      throw Object.assign(new Error("Paystack checkout could not be initialized. Please try again."), { providerFailure: true });
    }
  } catch (error) {
    if (error instanceof Error && error.providerFailure) return json(response, 502, { error: error.message, code: "provider_error" });
    if (error instanceof Error && error.configurationFailure) return json(response, 503, { error: error.message, code: "server_configuration_missing" });
    if (error instanceof Error && error.validationFailure) return json(response, 400, { error: error.message, code: "invalid_checkout" });
    return sendError(response, error, "Checkout could not be initialized.");
  }
}
