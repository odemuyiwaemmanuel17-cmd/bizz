import { adminClient, assertTransactionOwnership, authenticatedUser, evaluateSubscriptionCharge, json, methodAllowed, paystackRequest, requestBody, sendError } from "../_paystack.mjs";

const RECONCILABLE = new Set([
  "verification_data_incomplete",
  "plan_code_not_configured",
  "paystack_plan_code_missing",
  "paystack_plan_mismatch",
  "subscription_plan_mismatch",
  "plan_amount_mismatch",
  "plan_currency_mismatch",
  "plan_interval_invalid",
]);

async function planFor(client, local) {
  const planCode = typeof local.metadata?.plan_code === "string" ? local.metadata.plan_code : "";
  if (!planCode) return null;
  const result = await client.from("monetization_plans").select("code,name,price_cents,currency,billing_interval,paystack_plan_code").eq("code", planCode).maybeSingle();
  if (result.error) throw result.error;
  return result.data ?? null;
}

async function recordEvent(client, local, result) {
  // The RPC re-derives the same rules against authoritative database rows and
  // records the reconciliation state; it can never activate an entitlement
  // when the plan identity does not match.
  return client.rpc("process_paystack_event", {
    p_event_id: `verify:${local.provider_reference}`,
    p_event_type: "charge.success",
    p_reference: local.provider_reference,
    p_status: result.status,
    p_amount_cents: Number(result.amount),
    p_currency: String(result.currency).toUpperCase(),
    p_payload: { data: result, source: "server_verify" },
    p_provider_plan_code: result?.plan?.plan_code ?? result?.plan_code ?? null,
  });
}

export default async function handler(request, response) {
  if (!methodAllowed(request, response)) return;
  let client;
  try {
    client = adminClient();
    const user = await authenticatedUser(request, client);
    const body = requestBody(request);
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (!reference) throw Object.assign(new Error("Payment reference is required."), { validationFailure: true });

    const local = await client.from("payment_transactions").select("id,buyer_id,amount_cents,currency,status,provider_reference,transaction_kind,metadata,reconciliation_reason").eq("provider", "paystack").eq("provider_reference", reference).eq("buyer_id", user.id).maybeSingle();
    if (local.error) throw local.error;
    // Ownership is the authenticated user + the original transaction. A
    // callback URL or an email supplied by the browser can never grant this.
    const transaction = assertTransactionOwnership(local.data, user.id);
    if (!reference.startsWith("hustlehub_") || transaction.metadata?.hustlehub_kind === undefined) throw Object.assign(new Error("Payment purpose could not be verified."), { validationFailure: true });
    if (transaction.status === "succeeded") return json(response, 200, { verified: true, status: "succeeded", reference });
    if (transaction.status === "needs_reconciliation") {
      return json(response, 409, { error: "This payment needs manual reconciliation and has not granted a plan.", code: "reconciliation_required", reason: transaction.reconciliation_reason ?? null, reconciliationRequired: true });
    }
    if (transaction.status !== "pending") throw Object.assign(new Error("This payment is not awaiting verification."), { validationFailure: true });

    let result;
    try {
      result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    } catch (error) {
      console.error("[paystack verify] provider verification failed", { reference });
      throw Object.assign(new Error("Paystack could not verify this payment right now. Please retry shortly."), { providerFailure: true });
    }

    if (transaction.transaction_kind === "subscription") {
      const plan = await planFor(client, transaction);
      const evaluation = evaluateSubscriptionCharge({ local: transaction, remote: result, plan });
      if (!evaluation.ok && evaluation.code === "status_not_success") {
        await client.from("payment_transactions").update({ status: "failed", verification_status: "rejected", failure_reason: "Paystack reported an unsuccessful payment.", updated_at: new Date().toISOString() }).eq("id", transaction.id).eq("status", "pending");
        throw Object.assign(new Error("Paystack reported that this payment was not successful."), { validationFailure: true });
      }
      if (!evaluation.ok && !RECONCILABLE.has(evaluation.code)) {
        throw Object.assign(new Error(evaluation.reason), { validationFailure: true });
      }
      const processed = await recordEvent(client, transaction, result);
      if (processed.error) throw processed.error;
      if (evaluation.reconciliationRequired || processed.data?.reconciliation_required === true) {
        const reason = processed.data?.reason ?? evaluation.code;
        console.warn("[paystack verify] charge requires reconciliation", { reference, reason });
        return json(response, 409, { error: evaluation.reason ?? "This payment needs manual reconciliation and has not granted a plan.", code: "reconciliation_required", reason, reconciliationRequired: true });
      }
      console.info("[paystack verify] subscription charge verified", { reference, providerPlanCode: evaluation.verified.providerPlanCode });
      return json(response, 200, { verified: true, status: "succeeded", reference, planCode: evaluation.verified.providerPlanCode, billingInterval: evaluation.verified.billingInterval });
    }

    if (result?.reference !== transaction.provider_reference || result?.status !== "success" || Number(result?.amount) !== Number(transaction.amount_cents) || String(result?.currency).toUpperCase() !== String(transaction.currency).toUpperCase()) {
      if (result?.status && result.status !== "success") {
        await client.from("payment_transactions").update({ status: "failed", verification_status: "rejected", failure_reason: "Paystack reported an unsuccessful payment.", updated_at: new Date().toISOString() }).eq("id", transaction.id).eq("status", "pending");
        throw Object.assign(new Error("Paystack reported that this payment was not successful."), { validationFailure: true });
      }
      // A successful charge that does not match the local intent is never
      // discarded: it is recorded for reconciliation without granting a plan.
      const recorded = await recordEvent(client, transaction, result);
      if (recorded.error) throw recorded.error;
      return json(response, 409, { error: "This payment needs manual reconciliation and has not granted an entitlement.", code: "reconciliation_required", reconciliationRequired: true });
    }
    const processed = await recordEvent(client, transaction, result);
    if (processed.error) throw processed.error;
    if (processed.data?.reconciliation_required === true) {
      return json(response, 409, { error: "This payment needs manual reconciliation and has not granted an entitlement.", code: "reconciliation_required", reconciliationRequired: true, reason: processed.data.reason ?? null });
    }
    return json(response, 200, { verified: true, status: "succeeded", reference });
  } catch (error) {
    if (error instanceof Error && error.providerFailure) return json(response, 502, { error: error.message, code: "provider_error" });
    if (error instanceof Error && error.validationFailure) return json(response, 400, { error: error.message, code: "verification_rejected" });
    return sendError(response, error, "Payment could not be verified.");
  }
}
