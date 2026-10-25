import { getSupabase } from "./supabase";

export interface VerificationRequest {
  readonly id: string;
  readonly evidence: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly reviewerNote: string | null;
  readonly createdAt: string;
}

function currentUserId(value: { data: { user: { id: string } | null } }): string {
  const id = value.data.user?.id;
  if (id === undefined) throw new Error("Sign in to manage verification requests.");
  return id;
}

export async function listVerificationRequests(): Promise<VerificationRequest[]> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const auth = await sb.auth.getUser();
  const creatorId = currentUserId(auth);
  const result = await sb.from("creator_verification_requests").select("id,evidence,status,reviewer_note,created_at").eq("creator_id", creatorId).order("created_at", { ascending: false });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).map((row) => { const item = row as { id: string; evidence: string; status: VerificationRequest["status"]; reviewer_note?: string | null; created_at: string }; return { id: item.id, evidence: item.evidence, status: item.status, reviewerNote: item.reviewer_note ?? null, createdAt: item.created_at }; });
}

export async function submitVerificationRequest(evidence: string): Promise<void> {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  const auth = await sb.auth.getUser();
  const creatorId = currentUserId(auth);
  const text = evidence.trim();
  if (text.length < 10 || text.length > 2000) throw new Error("Evidence must be between 10 and 2,000 characters.");
  const result = await sb.from("creator_verification_requests").insert({ creator_id: creatorId, evidence: text, status: "pending" });
  if (result.error) throw new Error(result.error.message);
}
