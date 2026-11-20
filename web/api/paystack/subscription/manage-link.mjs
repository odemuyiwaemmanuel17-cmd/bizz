import {
  adminClient,
  assertPaystackManageLink,
  authenticatedUser,
  CheckoutError,
  isCancellableSubscription,
  json,
  methodAllowed,
  paystackRequest,
  requestBody,
  sendError,
} from "../../_paystack.mjs";

/**
 * Columns needed to prove ownership and eligibility. The Paystack subscription
 * code never leaves the server.
 */
const SUBSCRIPTION_FIELDS = "id,creator_id,plan_code,status,provider,provider_subscription_id,current_period_end,cancel_at_period_end";

const NOT_CANCELLABLE_MESSAGES = Object.freeze({
  pending: "This checkout has not been confirmed by Paystack yet. Finish or abandon it from Plans & Billing first.",
  incomplete: "This checkout was never completed, so there is no subscription to cancel.",
  needs_reconciliation: "This subscription needs manual review before it can be changed.",
  cancelled: "This subscription has already been cancelled.",
  expired: "This subscription has already ended.",
});

function explain(row) {
  if (row.status === "active" || row.status === "past_due") {
    return "This subscription has no Paystack subscription code, so it cannot be managed on Paystack.";
  }
  return NOT_CANCELLABLE_MESSAGES[row.status] ?? "This subscription cannot be cancelled from HustleHub.";
}

/**
 * Loads the subscription strictly by the authenticated user's id. A code, an
 * owner id, or an email supplied by the browser is never used for ownership.
 */
async function loadSubscription(client, userId, requestedId) {
  if (requestedId !== null) {
    const result = await client
      .from("creator_subscriptions")
      .select(SUBSCRIPTION_FIELDS)
      .eq("id", requestedId)
      .eq("creator_id", userId)
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data ?? null;
  }
  const result = await client
    .from("creator_subscriptions")
    .select(SUBSCRIPTION_FIELDS)
    .eq("creator_id", userId)
    .in("status", ["active", "past_due"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data ?? null;
}

export default async function handler(request, response) {
  if (!methodAllowed(request, response)) return;
  let client;
  try {
    client = adminClient();
    const user = await authenticatedUser(request, client);
    const body = requestBody(request);

    const rawId = body.subscriptionId;
    if (rawId !== undefined && rawId !== null && typeof rawId !== "string") {
      throw new CheckoutError("A subscription identifier must be a string.", 400, "invalid_subscription_id");
    }
    const requestedId = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : null;

    const subscription = await loadSubscription(client, user.id, requestedId);
    // Another account's subscription is indistinguishable from a missing one.
    if (subscription === null) {
      throw new CheckoutError("No cancellable subscription was found for this account.", 404, "subscription_not_found");
    }
    if (!isCancellableSubscription(subscription)) {
      throw new CheckoutError(explain(subscription), 409, "subscription_not_cancellable");
    }

    const code = subscription.provider_subscription_id;
    let providerData;
    try {
      providerData = await paystackRequest(`/subscription/${encodeURIComponent(code)}/manage/link`, {
        method: "GET",
        timeoutMs: 10_000,
      });
    } catch (error) {
      if (error instanceof CheckoutError) throw error;
      // Provider details stay in the server log; the subscription is untouched.
      console.error("[paystack manage-link] provider request failed", { subscriptionId: subscription.id });
      throw new CheckoutError("Paystack could not be reached, so your subscription is unchanged. Please try again.", 502, "provider_error");
    }

    const managementUrl = assertPaystackManageLink(providerData?.link);
    const alreadyScheduledForCancellation = subscription.cancel_at_period_end === true;

    console.info("[paystack manage-link] hosted management link issued", {
      subscriptionId: subscription.id,
      status: subscription.status,
      alreadyScheduledForCancellation,
    });

    // Only the redirect URL and a boolean leave the server.
    return json(response, 200, { managementUrl, alreadyScheduledForCancellation });
  } catch (error) {
    return sendError(response, error, "Your subscription could not be opened in Paystack.");
  }
}
