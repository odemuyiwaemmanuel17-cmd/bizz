import { adminClient, authenticatedUser, json, methodAllowed, paystackRequest, requestBody } from "../_paystack.mjs";

export default async function handler(request, response) {
  if (!methodAllowed(request, response)) return;
  const client = adminClient();
  try {
    const user = await authenticatedUser(request, client);
    const body = requestBody(request);
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (!reference) throw new Error("Payment reference is required.");
    const local = await client.from("payment_transactions").select("id,buyer_id,amount_cents,currency,status,provider_reference").eq("provider", "paystack").eq("provider_reference", reference).eq("buyer_id", user.id).single();
    if (local.error || !local.data) throw new Error("Payment transaction not found.");
    const result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    if (result.reference !== reference || result.status !== "success" || Number(result.amount) !== Number(local.data.amount_cents) || String(result.currency).toUpperCase() !== String(local.data.currency).toUpperCase()) throw new Error("Payment verification did not match the expected transaction.");
    const processed = await client.rpc("process_paystack_event", { p_event_id: `verify:${reference}`, p_event_type: "charge.success", p_reference: reference, p_status: result.status, p_amount_cents: Number(result.amount), p_currency: String(result.currency).toUpperCase(), p_payload: { data: result, source: "server_verify" } });
    if (processed.error) throw new Error(processed.error.message);
    return json(response, 200, { verified: true, status: "succeeded", reference });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "Payment could not be verified." });
  }
}
