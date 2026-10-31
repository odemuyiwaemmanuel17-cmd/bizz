import { adminClient, json, paystackSignatureMatches } from "../_paystack.mjs";
import crypto from "node:crypto";

export const config = { api: { bodyParser: false } };

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
  if (!paystackSignatureMatches(body, signature, secret)) return json(response, 401, { error: "Invalid webhook signature." });
  let event;
  try { event = JSON.parse(body.toString("utf8")); } catch { return json(response, 400, { error: "Invalid webhook JSON." }); }
  try {
    const data = event.data || {};
    const reference = data.reference || data.transaction?.reference || null;
    const eventId = String(event.id || `${event.event || "paystack"}:${data.id || data.reference || crypto.createHash("sha256").update(body).digest("hex")}`);
    const client = adminClient();
    const result = await client.rpc("process_paystack_event", { p_event_id: eventId, p_event_type: String(event.event || "unknown"), p_reference: reference, p_status: String(data.status || data.transaction?.status || ""), p_amount_cents: Number(data.amount || data.transaction?.amount || 0), p_currency: String(data.currency || data.transaction?.currency || "").toUpperCase(), p_payload: event });
    if (result.error) throw new Error(result.error.message);
    return json(response, 200, { received: true });
  } catch (error) {
    console.error("[paystack webhook] processing failed", error);
    return json(response, 500, { error: "Webhook processing failed." });
  }
}
