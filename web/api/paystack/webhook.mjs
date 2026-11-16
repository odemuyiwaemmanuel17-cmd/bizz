import { adminClient, ingestWebhook, json } from "../_paystack.mjs";

export const config = { api: { bodyParser: false } };
export const maxDuration = 30;

async function rawBody(request) {
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === "string") return Buffer.from(request.body);
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed." });
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json(response, 503, { error: "Paystack webhook is not configured." });

  const body = await rawBody(request);
  const signature = request.headers["x-paystack-signature"];

  let client;
  try {
    client = adminClient();
  } catch {
    console.error("[paystack webhook] server credentials are not configured");
    return json(response, 503, { error: "Paystack webhook is not configured." });
  }

  const outcome = await ingestWebhook({
    rawBody: body,
    signature,
    secret,
    rpc: async (args) => {
      const result = await client.rpc("process_paystack_event", args);
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });

  if (outcome.status === "unauthorized") {
    console.warn("[paystack webhook] rejected unsigned payload");
    return json(response, 401, { error: "Invalid webhook signature." });
  }
  if (outcome.status === "invalid_json") return json(response, 400, { error: "Invalid webhook JSON." });
  if (outcome.status === "unconfigured") return json(response, 503, { error: "Paystack webhook is not configured." });
  if (outcome.status === "failed") {
    // The RPC records the failure on the event row and re-raises so Paystack
    // retries; the response stays generic and never echoes provider detail.
    console.error("[paystack webhook] processing failed", outcome.diagnostic, { message: outcome.message });
    return json(response, 500, { error: "Webhook processing failed.", retry: true });
  }
  if (outcome.status === "needs_reconciliation") {
    console.warn("[paystack webhook] recorded for reconciliation", outcome.diagnostic, outcome.result);
    // 200 stops Paystack retrying a charge that is already recorded and
    // waiting for a human decision. The event row holds the audit trail.
    return json(response, 200, { received: true, reconciliation: "required" });
  }
  console.info("[paystack webhook] processed", outcome.diagnostic);
  return json(response, 200, { received: true });
}
