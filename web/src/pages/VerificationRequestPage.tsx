import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import {
  listVerificationRequests,
  submitVerificationApplication,
  type VerificationCategory,
  type VerificationRequest,
} from "../lib/verification";

const CATEGORY_LABELS: Readonly<Record<VerificationCategory, string>> = {
  identity: "Identity",
  business: "Business",
  professional: "Professional",
  creator: "Creator / public presence",
  other: "Other",
};

function statusLabel(status: VerificationRequest["status"]): string {
  if (status === "more_info_required") return "More information required";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClass(status: VerificationRequest["status"]): string {
  if (status === "approved") return "bg-emerald-400/10 text-emerald-200";
  if (status === "rejected") return "bg-rose-400/10 text-rose-200";
  if (status === "more_info_required") return "bg-amber-400/10 text-amber-200";
  return "bg-cyan-400/10 text-cyan-200";
}

export default function VerificationRequestPage(): ReactElement {
  const navigate = useNavigate();
  const { isAuthenticated, status } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [category, setCategory] = useState<VerificationCategory>("creator");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [website, setWebsite] = useState("");
  const [professionalDetails, setProfessionalDetails] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload(): Promise<void> {
    setRequests(await listVerificationRequests());
  }

  useEffect(() => {
    if (status === "config-missing") { setLoading(false); return; }
    if (!isAuthenticated) {
      const timer = window.setTimeout(() => navigate(`/auth?next=${encodeURIComponent("/dashboard/verification")}`, { replace: true }), 1200);
      return () => window.clearTimeout(timer);
    }
    let active = true;
    void listVerificationRequests().then((rows) => { if (active) setRequests(rows); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Verification requests could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAuthenticated, navigate, status]);

  const openRequest = useMemo(() => requests.find((request) => request.status === "pending" || request.status === "more_info_required") ?? null, [requests]);
  const canSubmit = openRequest === null || openRequest.status === "more_info_required";

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>): void {
    setFiles(Array.from(event.target.files ?? []));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      await submitVerificationApplication({ category, reason, evidence, businessName, website, professionalDetails, files });
      setReason(""); setEvidence(""); setBusinessName(""); setWebsite(""); setProfessionalDetails(""); setFiles([]); setFileInputKey((value) => value + 1);
      await reload();
      setNotice("Your application was submitted for review. A verified badge appears only after approval.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification application could not be submitted.");
    } finally { setBusy(false); }
  }

  if (status === "config-missing") return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32"><section className="glass rounded-3xl p-8 text-center"><h1 className="text-2xl font-bold text-white">Verification requests unavailable</h1><p className="mt-2 text-sm text-slate-400">Connect Supabase to submit a real request.</p></section></main>;
  if (!isAuthenticated) return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Checking your session…</p></main>;

  return <main className="mx-auto max-w-3xl px-4 pb-20 pt-32">
    <div className="mb-6"><Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link><h1 className="mt-4 text-3xl font-black text-white">Creator verification</h1><p className="mt-2 text-sm leading-6 text-slate-400">Submit accurate information and evidence for an administrator to review. Approval is never automatic.</p></div>
    {openRequest?.status === "pending" && <p className="mb-5 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">Your application is pending review. You can submit more evidence if an administrator requests it.</p>}
    {openRequest?.status === "more_info_required" && <p className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"><strong>More information required:</strong> {openRequest.reviewerNote ?? "Please add the requested information below."}</p>}
    <section className="glass rounded-3xl p-6">
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        <label className="block text-sm text-slate-300">Verification category<select value={category} onChange={(event) => setCategory(event.target.value as VerificationCategory)} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-white">{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block text-sm text-slate-300">Why should this creator be verified?<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={2000} rows={4} placeholder="Explain the public identity, business, or professional presence you want reviewed." className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /><span className="mt-1 block text-right text-xs text-slate-500">{reason.length}/2000</span></label>
        <label className="block text-sm text-slate-300">Evidence and links<textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} minLength={10} maxLength={2000} rows={6} placeholder="Share portfolio links, press, business registration context, or other evidence a reviewer can verify." className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /><span className="mt-1 block text-right text-xs text-slate-500">{evidence.length}/2000</span></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm text-slate-300">Business or professional name<input value={businessName} onChange={(event) => setBusinessName(event.target.value)} maxLength={160} className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Website or public profile<input value={website} onChange={(event) => setWebsite(event.target.value)} maxLength={500} placeholder="https://…" className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /></label></div>
        <label className="block text-sm text-slate-300">Professional or identity details<textarea value={professionalDetails} onChange={(event) => setProfessionalDetails(event.target.value)} maxLength={2000} rows={4} placeholder="Add context that helps the administrator verify this application." className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /></label>
        <label className="block text-sm text-slate-300">Evidence files <span className="text-xs text-slate-500">(optional, up to 8 files, 10 MB each)</span><input key={fileInputKey} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,text/plain" onChange={chooseFiles} className="mt-2 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/80 file:px-3 file:py-2 file:font-semibold file:text-white" />{files.length > 0 && <span className="mt-2 block text-xs text-slate-400">Selected: {files.map((file) => file.name).join(", ")}</span>}</label>
        {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}{notice && <p role="status" className="text-sm text-emerald-200">{notice}</p>}
        <button type="submit" disabled={busy || !canSubmit || reason.trim().length < 10 || evidence.trim().length < 10} className="btn-primary disabled:opacity-50">{busy ? "Submitting…" : openRequest?.status === "more_info_required" ? "Submit additional information" : "Submit application"}</button>
      </form>
    </section>
    <section className="mt-8"><h2 className="text-lg font-bold text-white">Your application history</h2>{loading && <p className="mt-3 text-sm text-slate-400">Loading request history…</p>}{!loading && !error && requests.length === 0 && <p className="mt-3 text-sm text-slate-500">No verification applications submitted yet.</p>}{requests.length > 0 && <ul className="mt-3 space-y-4">{requests.map((request) => <li key={request.id} className="rounded-2xl border border-white/10 bg-white/5 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wider text-slate-500">{CATEGORY_LABELS[request.verificationCategory]} · {new Date(request.createdAt).toLocaleString()}</p><p className="mt-1 font-mono text-xs text-slate-500">Application {request.id}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClass(request.status)}`}>{statusLabel(request.status)}</span></div><p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{request.requestReason}</p>{request.reviewerNote && <p className="mt-3 rounded-xl border border-white/10 bg-black/10 p-3 text-sm text-amber-100"><strong>Administrator note:</strong> {request.reviewerNote}</p>}{request.evidenceFiles.length > 0 && <p className="mt-3 text-xs text-slate-400">{request.evidenceFiles.length} evidence file{request.evidenceFiles.length === 1 ? "" : "s"} securely stored.</p>}</li>)}</ul>}</section>
  </main>;
}
