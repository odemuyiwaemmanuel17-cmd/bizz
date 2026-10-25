import { getSupabase } from "./supabase";

export type VerificationStatus = "pending" | "approved" | "rejected" | "more_info_required";
export type VerificationCategory = "identity" | "business" | "professional" | "creator" | "other";

export interface VerificationEvidence {
  readonly id: string;
  readonly requestId: string;
  readonly storagePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface VerificationRequest {
  readonly id: string;
  readonly evidence: string;
  readonly verificationCategory: VerificationCategory;
  readonly requestReason: string;
  readonly details: Record<string, unknown>;
  readonly status: VerificationStatus;
  readonly reviewerNote: string | null;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly evidenceFiles: readonly VerificationEvidence[];
}

export interface VerificationApplicationInput {
  readonly category: VerificationCategory;
  readonly reason: string;
  readonly evidence: string;
  readonly businessName: string;
  readonly website: string;
  readonly professionalDetails: string;
  readonly files: readonly File[];
}

export interface AdminVerificationSummary {
  readonly id: string;
  readonly creatorId: string;
  readonly creatorName: string;
  readonly creatorUsername: string | null;
  readonly avatarUrl: string | null;
  readonly verificationCategory: VerificationCategory;
  readonly requestReason: string;
  readonly status: VerificationStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export interface AdminVerificationApplication {
  readonly request: VerificationRequest;
  readonly creator: {
    readonly id: string;
    readonly username: string | null;
    readonly displayName: string | null;
    readonly avatarUrl: string | null;
    readonly bio: string | null;
    readonly campus: string | null;
    readonly state: string | null;
    readonly country: string | null;
    readonly creatorType: string | null;
    readonly isVerified: boolean;
  };
  readonly audit: readonly VerificationAuditEntry[];
}

export interface VerificationAuditEntry {
  readonly id: string;
  readonly administratorId: string;
  readonly previousStatus: VerificationStatus;
  readonly newStatus: VerificationStatus;
  readonly decisionNote: string | null;
  readonly createdAt: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 8;
const ALLOWED_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"]);

function requireSupabase() {
  const sb = getSupabase();
  if (sb === null) throw new Error("Supabase is not configured.");
  return sb;
}

async function currentUserId(): Promise<string> {
  const sb = requireSupabase();
  const auth = await sb.auth.getUser();
  const id = auth.data.user?.id;
  if (id === undefined) throw new Error("Sign in to manage verification requests.");
  return id;
}

function asCategory(value: unknown): VerificationCategory {
  return value === "identity" || value === "business" || value === "professional" || value === "creator" ? value : "other";
}

function asStatus(value: unknown): VerificationStatus {
  if (value === "approved" || value === "rejected" || value === "more_info_required") return value;
  return "pending";
}

function asDetails(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapEvidence(row: Record<string, unknown>): VerificationEvidence {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    storagePath: String(row.storage_path),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    createdAt: String(row.created_at),
  };
}

function mapRequest(row: Record<string, unknown>, evidenceFiles: readonly VerificationEvidence[] = []): VerificationRequest {
  return {
    id: String(row.id),
    evidence: String(row.evidence ?? ""),
    verificationCategory: asCategory(row.verification_category),
    requestReason: String(row.request_reason ?? ""),
    details: asDetails(row.details),
    status: asStatus(row.status),
    reviewerNote: typeof row.reviewer_note === "string" ? row.reviewer_note : null,
    createdAt: String(row.created_at),
    reviewedAt: typeof row.reviewed_at === "string" ? row.reviewed_at : null,
    evidenceFiles,
  };
}

export function validateEvidenceFile(file: File): string | null {
  if (!ALLOWED_FILE_TYPES.has(file.type)) return "Use a JPG, PNG, WEBP, PDF, or TXT evidence file.";
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) return "Each evidence file must be smaller than 10 MB.";
  return null;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "evidence";
}

function randomId(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listVerificationRequests(): Promise<VerificationRequest[]> {
  const sb = requireSupabase();
  const creatorId = await currentUserId();
  const result = await sb
    .from("creator_verification_requests")
    .select("id,evidence,verification_category,request_reason,details,status,reviewer_note,created_at,reviewed_at")
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false });
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<Record<string, unknown>>;
  const ids = rows.map((row) => String(row.id));
  if (ids.length === 0) return [];
  const files = await sb.from("creator_verification_evidence").select("id,request_id,storage_path,file_name,mime_type,size_bytes,created_at").in("request_id", ids).order("created_at", { ascending: true });
  if (files.error) throw new Error(files.error.message);
  const byRequest = new Map<string, VerificationEvidence[]>();
  for (const row of (files.data ?? []) as Array<Record<string, unknown>>) {
    const item = mapEvidence(row);
    const current = byRequest.get(item.requestId) ?? [];
    current.push(item);
    byRequest.set(item.requestId, current);
  }
  return rows.map((row) => mapRequest(row, byRequest.get(String(row.id)) ?? []));
}

export async function submitVerificationApplication(input: VerificationApplicationInput): Promise<string> {
  const sb = requireSupabase();
  const creatorId = await currentUserId();
  const reason = input.reason.trim();
  const evidence = input.evidence.trim();
  if (reason.length < 10 || reason.length > 2000) throw new Error("The verification reason must be between 10 and 2,000 characters.");
  if (evidence.length < 10 || evidence.length > 2000) throw new Error("Evidence must be between 10 and 2,000 characters.");
  if (input.files.length > MAX_FILES) throw new Error(`Upload no more than ${MAX_FILES} evidence files.`);
  for (const file of input.files) {
    const fileError = validateEvidenceFile(file);
    if (fileError !== null) throw new Error(fileError);
  }
  const details = {
    businessName: input.businessName.trim(),
    website: input.website.trim(),
    professionalDetails: input.professionalDetails.trim(),
  };
  const submitted = await sb.rpc("submit_creator_verification", {
    p_verification_category: input.category,
    p_request_reason: reason,
    p_evidence: evidence,
    p_details: details,
  });
  if (submitted.error || typeof submitted.data !== "string") throw new Error(submitted.error?.message ?? "Verification application could not be submitted.");
  const requestId = submitted.data;
  const uploadedPaths: string[] = [];
  try {
    for (const file of input.files) {
      const storagePath = `${creatorId}/${requestId}/${randomId()}-${safeFileName(file.name)}`;
      const uploaded = await sb.storage.from("verification-evidence").upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploaded.error) throw new Error(`Evidence upload failed: ${uploaded.error.message}`);
      uploadedPaths.push(storagePath);
      const metadata = await sb.from("creator_verification_evidence").insert({
        request_id: requestId,
        creator_id: creatorId,
        storage_path: storagePath,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      });
      if (metadata.error) throw new Error(`Evidence record could not be saved: ${metadata.error.message}`);
    }
  } catch (error: unknown) {
    if (uploadedPaths.length > 0) await sb.storage.from("verification-evidence").remove(uploadedPaths);
    throw error;
  }
  return requestId;
}

/** Backwards-compatible wrapper for the original text-only form. */
export async function submitVerificationRequest(evidence: string): Promise<void> {
  await submitVerificationApplication({ category: "other", reason: evidence, evidence, businessName: "", website: "", professionalDetails: "", files: [] });
}

export async function isCurrentVerificationAdmin(): Promise<boolean> {
  const sb = requireSupabase();
  const result = await sb.rpc("is_verification_admin");
  if (result.error) throw new Error(result.error.message);
  return result.data === true;
}

export async function listAdminVerificationRequests(status: VerificationStatus | "all", search: string): Promise<AdminVerificationSummary[]> {
  const sb = requireSupabase();
  const result = await sb.rpc("admin_list_creator_verification_requests", { p_status: status === "all" ? null : status, p_search: search.trim() || null });
  if (result.error) throw new Error(result.error.message);
  return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    creatorId: String(row.creator_id),
    creatorName: String(row.creator_name),
    creatorUsername: typeof row.creator_username === "string" ? row.creator_username : null,
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
    verificationCategory: asCategory(row.verification_category),
    requestReason: String(row.request_reason ?? ""),
    status: asStatus(row.status),
    createdAt: String(row.created_at),
    reviewedAt: typeof row.reviewed_at === "string" ? row.reviewed_at : null,
  }));
}

export async function pendingVerificationCount(): Promise<number> {
  const sb = requireSupabase();
  const result = await sb.rpc("admin_pending_creator_verification_count");
  if (result.error) throw new Error(result.error.message);
  return Number(result.data ?? 0);
}

export async function getAdminVerificationApplication(requestId: string): Promise<AdminVerificationApplication> {
  const sb = requireSupabase();
  const [requestResult, filesResult, auditResult] = await Promise.all([
    sb.from("creator_verification_requests").select("id,creator_id,evidence,verification_category,request_reason,details,status,reviewer_note,created_at,reviewed_at").eq("id", requestId).single(),
    sb.from("creator_verification_evidence").select("id,request_id,storage_path,file_name,mime_type,size_bytes,created_at").eq("request_id", requestId).order("created_at", { ascending: true }),
    sb.from("creator_verification_audit").select("id,administrator_id,previous_status,new_status,decision_note,created_at").eq("request_id", requestId).order("created_at", { ascending: false }),
  ]);
  if (requestResult.error || requestResult.data === null) throw new Error(requestResult.error?.message ?? "Verification application could not be loaded.");
  if (filesResult.error) throw new Error(filesResult.error.message);
  if (auditResult.error) throw new Error(auditResult.error.message);
  const requestRow = requestResult.data as Record<string, unknown>;
  const creatorResult = await sb.from("profiles").select("id,username,display_name,avatar_url,bio,campus,state,country,creator_type,is_verified").eq("id", String(requestRow.creator_id)).single();
  if (creatorResult.error || creatorResult.data === null) throw new Error(creatorResult.error?.message ?? "Creator profile could not be loaded.");
  const creator = creatorResult.data as Record<string, unknown>;
  return {
    request: mapRequest(requestRow, ((filesResult.data ?? []) as Array<Record<string, unknown>>).map(mapEvidence)),
    creator: {
      id: String(creator.id), username: typeof creator.username === "string" ? creator.username : null, displayName: typeof creator.display_name === "string" ? creator.display_name : null,
      avatarUrl: typeof creator.avatar_url === "string" ? creator.avatar_url : null, bio: typeof creator.bio === "string" ? creator.bio : null,
      campus: typeof creator.campus === "string" ? creator.campus : null, state: typeof creator.state === "string" ? creator.state : null,
      country: typeof creator.country === "string" ? creator.country : null, creatorType: typeof creator.creator_type === "string" ? creator.creator_type : null,
      isVerified: creator.is_verified === true,
    },
    audit: ((auditResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), administratorId: String(row.administrator_id), previousStatus: asStatus(row.previous_status), newStatus: asStatus(row.new_status),
      decisionNote: typeof row.decision_note === "string" ? row.decision_note : null, createdAt: String(row.created_at),
    })),
  };
}

export async function createEvidenceSignedUrl(storagePath: string): Promise<string> {
  const sb = requireSupabase();
  const result = await sb.storage.from("verification-evidence").createSignedUrl(storagePath, 300);
  if (result.error || result.data?.signedUrl === undefined) throw new Error(result.error?.message ?? "Evidence file could not be opened.");
  return result.data.signedUrl;
}

export async function reviewVerificationApplication(requestId: string, action: "approve" | "reject" | "request_more_information", note: string): Promise<void> {
  const sb = requireSupabase();
  const result = await sb.rpc("admin_review_creator_verification", { p_request_id: requestId, p_action: action, p_note: note.trim() || null });
  if (result.error) throw new Error(result.error.message);
}
