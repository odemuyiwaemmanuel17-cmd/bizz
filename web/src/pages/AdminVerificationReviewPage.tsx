import { useEffect, useState, type ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { creatorProfilePath } from "../lib/creator";
import {
  createEvidenceSignedUrl,
  getAdminVerificationApplication,
  isCurrentVerificationAdmin,
  reviewVerificationApplication,
  type AdminVerificationApplication,
  type VerificationEvidence,
  type VerificationStatus,
} from "../lib/verification";

function statusLabel(status: VerificationStatus): string {
  return status === "more_info_required" ? "More information required" : status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function prettyLabel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function EvidenceCard({ file, signedUrl }: { readonly file: VerificationEvidence; readonly signedUrl: string | null }) {
  return <article className="rounded-2xl border border-white/10 bg-white/5 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold text-white">{file.fileName}</p><p className="mt-1 text-xs text-slate-500">{file.mimeType} · {Math.ceil(file.sizeBytes / 1024)} KB</p></div>{signedUrl && <a href={signedUrl} target="_blank" rel="noreferrer" className="btn-glass shrink-0 px-3 py-1.5 text-xs">Open / download</a>}</div>{signedUrl === null && <p className="mt-3 text-xs text-rose-200">This file could not be opened. The storage object may be missing or corrupted.</p>}{signedUrl && file.mimeType.startsWith("image/") && <img src={signedUrl} alt={file.fileName} className="mt-4 max-h-96 w-full rounded-xl bg-black/30 object-contain" />}{signedUrl && file.mimeType === "application/pdf" && <iframe title={file.fileName} src={signedUrl} className="mt-4 h-96 w-full rounded-xl bg-white" />}</article>;
}

export default function AdminVerificationReviewPage(): ReactElement {
  const { requestId } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, status } = useAuth();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [application, setApplication] = useState<AdminVerificationApplication | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    if (requestId === undefined) return;
    setLoading(true); setError(null);
    try {
      const next = await getAdminVerificationApplication(requestId);
      setApplication(next);
      const urlEntries = await Promise.all(next.request.evidenceFiles.map(async (file) => {
        try { return [file.id, await createEvidenceSignedUrl(file.storagePath)] as const; } catch { return [file.id, null] as const; }
      }));
      setSignedUrls(Object.fromEntries(urlEntries));
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Verification application could not be loaded."); } finally { setLoading(false); }
  }

  useEffect(() => {
    if (status === "config-missing") { setLoading(false); return; }
    if (!isAuthenticated) { const timer = window.setTimeout(() => navigate(`/auth?next=${encodeURIComponent(`/admin/verification/${requestId ?? ""}`)}`, { replace: true }), 500); return () => window.clearTimeout(timer); }
    let active = true;
    void isCurrentVerificationAdmin().then((allowed) => { if (active) setAdmin(allowed); if (allowed && active) void load(); }).catch((err: unknown) => { if (active) { setError(err instanceof Error ? err.message : "Administrator access could not be checked."); setLoading(false); } });
    return () => { active = false; };
  }, [isAuthenticated, navigate, requestId, status]);

  async function review(action: "approve" | "reject" | "request_more_information"): Promise<void> {
    if (requestId === undefined) return;
    if (action === "approve" && !window.confirm("Approve this creator and enable the verified badge?")) return;
    if ((action === "reject" || action === "request_more_information") && note.trim().length < 3) { setError("Add a reason or request message before continuing."); return; }
    setBusy(true); setError(null);
    try { await reviewVerificationApplication(requestId, action, note); setNote(""); await load(); } catch (err: unknown) { setError(err instanceof Error ? err.message : "Review decision could not be saved."); } finally { setBusy(false); }
  }

  if (status === "config-missing") return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Connect Supabase and apply the creator verification admin migration.</p></main>;
  if (!isAuthenticated || admin === null) return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Checking administrator access…</p></main>;
  if (admin !== true) return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32 text-center"><h1 className="text-2xl font-bold text-white">Not authorized</h1><p className="mt-2 text-sm text-slate-400">This review page is restricted to explicitly authorized administrators.</p></main>;
  if (loading) return <main className="mx-auto max-w-4xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Loading submitted application and evidence…</p></main>;
  if (error && application === null) return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32"><p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p><Link to="/admin/verification" className="btn-glass mt-5 inline-block">Back to queue</Link></main>;
  if (application === null) return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32"><p className="text-slate-400">Application not found.</p></main>;

  const { request, creator, audit } = application;
  const finalized = request.status === "approved" || request.status === "rejected";
  return <main className="mx-auto max-w-6xl px-4 pb-20 pt-32">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><Link to="/admin/verification" className="text-sm text-slate-400 hover:text-white">← Verification queue</Link><h1 className="mt-3 text-3xl font-black text-white">Review creator application</h1><p className="mt-2 font-mono text-xs text-slate-500">{request.id}</p></div><span className="rounded-full bg-white/10 px-3 py-2 text-sm font-semibold text-slate-200">{statusLabel(request.status)}</span></div>
    {error && <p role="alert" className="mt-5 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>}
    <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
      <div className="space-y-6"><section className="glass rounded-3xl p-6"><h2 className="text-lg font-bold text-white">Creator profile</h2><div className="mt-4 flex flex-wrap items-center gap-4"><div className="h-20 w-20 overflow-hidden rounded-full bg-white/10">{creator.avatarUrl ? <img src={creator.avatarUrl} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center text-2xl font-black text-white">{(creator.displayName ?? creator.username ?? "C").charAt(0).toUpperCase()}</span>}</div><div><h3 className="text-xl font-bold text-white">{creator.displayName ?? creator.username ?? "Unnamed creator"}</h3><p className="text-sm text-slate-400">@{creator.username ?? "unknown"}</p><Link to={creatorProfilePath(creator.username, creator.id)} className="mt-2 inline-block text-sm text-cyan-200 hover:text-white">Open public profile →</Link></div></div><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">Creator type</dt><dd className="text-slate-200">{creator.creatorType ?? "—"}</dd></div><div><dt className="text-slate-500">Location</dt><dd className="text-slate-200">{[creator.campus, creator.state, creator.country].filter(Boolean).join(", ") || "—"}</dd></div></dl>{creator.bio && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-300">{creator.bio}</p>}</section>
      <section className="glass rounded-3xl p-6"><h2 className="text-lg font-bold text-white">Submitted application</h2><dl className="mt-4 space-y-4 text-sm"><div><dt className="text-slate-500">Category</dt><dd className="text-slate-200">{request.verificationCategory}</dd></div><div><dt className="text-slate-500">Reason</dt><dd className="whitespace-pre-wrap text-slate-200">{request.requestReason}</dd></div><div><dt className="text-slate-500">Evidence and links</dt><dd className="whitespace-pre-wrap text-slate-200">{request.evidence}</dd></div><div><dt className="text-slate-500">Submitted</dt><dd className="text-slate-200">{formatDate(request.createdAt)}</dd></div><div><dt className="text-slate-500">Last reviewed</dt><dd className="text-slate-200">{formatDate(request.reviewedAt)}</dd></div></dl>{Object.keys(request.details).length > 0 && <div className="mt-5 border-t border-white/10 pt-4"><h3 className="text-sm font-semibold text-white">Additional details</h3><dl className="mt-3 space-y-3 text-sm">{Object.entries(request.details).map(([key, value]) => <div key={key}><dt className="text-slate-500">{prettyLabel(key)}</dt><dd className="whitespace-pre-wrap text-slate-200">{String(value || "—")}</dd></div>)}</dl></div>}</section>
      <section className="glass rounded-3xl p-6"><h2 className="text-lg font-bold text-white">Evidence files</h2><p className="mt-2 text-sm text-slate-400">Files are opened through short-lived signed URLs. They are not public URLs.</p><div className="mt-4 space-y-3">{request.evidenceFiles.length === 0 && <p className="text-sm text-slate-500">No files were uploaded.</p>}{request.evidenceFiles.map((file) => <EvidenceCard key={file.id} file={file} signedUrl={signedUrls[file.id] ?? null} />)}</div></section></div>
      <aside className="space-y-6"><section className="glass rounded-3xl p-6"><h2 className="text-lg font-bold text-white">Review decision</h2>{finalized ? <p className="mt-3 text-sm text-slate-400">This application is finalized. A new application is required after a rejection.</p> : <><label className="mt-4 block text-sm text-slate-300">Decision reason or additional-information request<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={7} placeholder="Required for rejection or more information." className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /></label><div className="mt-4 grid gap-2"><button type="button" disabled={busy} onClick={() => void review("approve")} className="btn-primary disabled:opacity-50">{busy ? "Saving…" : "Approve and verify"}</button><button type="button" disabled={busy} onClick={() => void review("request_more_information")} className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-100 disabled:opacity-50">Request more information</button><button type="button" disabled={busy} onClick={() => void review("reject")} className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2.5 text-sm font-semibold text-rose-100 disabled:opacity-50">Reject application</button></div></>}</section>
      <section className="glass rounded-3xl p-6"><h2 className="text-lg font-bold text-white">Review history</h2>{audit.length === 0 ? <p className="mt-3 text-sm text-slate-500">No previous review decisions.</p> : <ol className="mt-4 space-y-4">{audit.map((entry) => <li key={entry.id} className="border-l border-white/15 pl-4"><p className="text-sm font-semibold text-white">{statusLabel(entry.previousStatus)} → {statusLabel(entry.newStatus)}</p><p className="mt-1 text-xs text-slate-500">{formatDate(entry.createdAt)} · administrator {entry.administratorId}</p>{entry.decisionNote && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{entry.decisionNote}</p>}</li>)}</ol>}</section></aside>
    </div>
  </main>;
}
