import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export function json(response, status, body) {
  response.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

export function methodAllowed(request, response, method = "POST") {
  if (request.method === method) return true;
  response.setHeader("Allow", method);
  json(response, 405, { error: "Method not allowed." });
  return false;
}

export function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Server Supabase credentials are not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function authenticatedUser(request, client) {
  const header = request.headers.authorization || request.headers.Authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new Error("Authentication is required.");
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new Error("Authentication is required.");
  const result = await client.auth.getUser(token);
  if (result.error || !result.data.user) throw new Error("Authentication is invalid or expired.");
  return result.data.user;
}

export function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).replace(/\/$/, "");
}

export async function paystackRequest(path, options = {}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured on the server.");
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== true) throw new Error(body.message || `Paystack request failed (${response.status}).`);
  return body.data;
}

export async function enabledConfig(client, capability) {
  const result = await client.from("monetization_config").select("environment,provider,payments_enabled,subscriptions_enabled,paid_promotions_enabled").eq("id", 1).single();
  if (result.error) throw new Error(result.error.message);
  const config = result.data;
  if (config.provider !== "paystack") throw new Error("Paystack is not the configured payment provider.");
  if (config.environment !== "test") throw new Error("Paystack checkout is not enabled. Configure test mode before accepting charges.");
  if (config.payments_enabled !== true || config[capability] !== true) throw new Error("This payment feature is currently disabled.");
  return config;
}

export function requestBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    try {
      const parsed = JSON.parse(request.body);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function reference(prefix) {
  return `hustlehub_${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function paystackSignatureMatches(body, signature, secret) {
  if (!secret || typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha512", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

export function assertVerifiedTransaction(local, remote) {
  if (remote?.reference !== local.provider_reference || remote?.status !== "success" || Number(remote?.amount) !== Number(local.amount_cents) || String(remote?.currency).toUpperCase() !== String(local.currency).toUpperCase()) {
    throw new Error("Payment verification did not match the expected transaction.");
  }
}

export function checkoutKind(value) {
  if (value === "subscription" || value === "promotion") return value;
  throw new Error("A valid checkout type is required.");
}
