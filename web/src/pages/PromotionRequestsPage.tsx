import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { currentUserId, listPromotionRequests, submitPromotionRequest, type PromotionRequest } from "../lib/marketplaceActions";
import { formatMinorAmount, getPromotionPackages, startPaystackCheckout, type PromotionPackage } from "../lib/monetization";
import { getSupabase } from "../lib/supabase";

export default function PromotionRequestsPage(): ReactElement {
  const { isAuthenticated, status } = useAuth();
  const [listingId, setListingId] = useState("");
  const [note, setNote] = useState("");
  const [requests, setRequests] = useState<PromotionRequest[]>([]);
  const [listings, setListings] = useState<Array<{ id: string; title: string }>>([]);
  const [packages, setPackages] = useState<readonly PromotionPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return; }
    const sb = getSupabase();
    if (sb === null) { setLoading(false); return; }
    let active = true;
    void Promise.all([
      listPromotionRequests(),
      getPromotionPackages().catch(() => [] as readonly PromotionPackage[]),
      currentUserId().then((userId) => sb.from("listings").select("id,title").eq("user_id", userId).eq("status", "active")),
    ]).then(([history, availablePackages, owned]) => {
      if (!active) return;
      setRequests(history); setPackages(availablePackages);
      if (!owned.error) setListings((owned.data ?? []) as Array<{ id: string; title: string }>);
    }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "Promotion data could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAuthenticated]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy("request"); setMessage(null);
    try { await submitPromotionRequest(listingId, note); setNote(""); setRequests(await listPromotionRequests()); setMessage("Interest request submitted. No payment was collected."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Request could not be submitted."); }
    finally { setBusy(null); }
  }

  async function buyPackage(packageRow: PromotionPackage): Promise<void> {
    if (!listingId) { setMessage("Choose an active Bizz before selecting a package."); return; }
    setBusy(packageRow.id); setMessage(null);
    try { const checkout = await startPaystackCheckout({ kind: "promotion", packageId: packageRow.id, targetId: listingId }); window.location.assign(checkout.authorizationUrl); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Promotion checkout could not be started."); setBusy(null); }
  }

  if (status === "config-missing") return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32"><section className="glass rounded-3xl p-8 text-center"><h1 className="text-2xl font-bold text-white">Promotion tools unavailable</h1><p className="mt-2 text-sm text-slate-400">Connect Supabase to use this workflow.</p></section></main>;
  if (!isAuthenticated) return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32 text-center"><p className="text-slate-400">Sign in to promote a Bizz.</p><Link to="/auth?next=%2Fdashboard%2Fpromotions" className="btn-primary mt-5 inline-block">Sign in</Link></main>;
  return <main className="mx-auto max-w-2xl px-4 pb-20 pt-32"><Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link><h1 className="mt-4 text-3xl font-black text-white">Promote a Bizz</h1><p className="mt-2 text-sm leading-6 text-slate-400">Promotion packages are configurable and remain clearly sponsored. Checkout is server-controlled and disabled until Paystack test mode is enabled.</p><section className="glass mt-6 rounded-3xl p-6"><form onSubmit={(event) => void submit(event)} className="space-y-4"><label className="block text-sm text-slate-300">Active Bizz<select value={listingId} onChange={(event) => setListingId(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-white"><option value="">Choose a Bizz</option>{listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}</select></label><label className="block text-sm text-slate-300">What would you want to promote?<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={5} placeholder="Tell us about the audience or goal. No payment is collected here." className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white placeholder:text-slate-500" /><span className="mt-1 block text-right text-xs text-slate-500">{note.length}/1000</span></label>{message && <p role="status" className="text-sm text-slate-300">{message}</p>}<button type="submit" disabled={busy !== null || listingId.length === 0 || note.trim().length < 10} className="btn-primary disabled:opacity-50">{busy === "request" ? "Submitting…" : "Submit interest request"}</button></form></section>{packages.length > 0 && <section className="mt-6"><h2 className="text-lg font-bold text-white">Paid promotion packages</h2><div className="mt-3 grid gap-3">{packages.map((packageRow) => <article key={packageRow.id} className="rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-white">{packageRow.name}</h3><p className="mt-1 text-xs text-slate-400">{packageRow.durationDays} days · {packageRow.placement.replaceAll("_", " ")}</p><p className="mt-2 text-xs leading-5 text-slate-500">{packageRow.terms}</p></div><div className="text-right"><p className="font-bold text-white">{formatMinorAmount(packageRow.priceCents, packageRow.currency)}</p><button type="button" disabled={busy !== null || !listingId} onClick={() => void buyPackage(packageRow)} className="btn-primary mt-3 px-3 py-1.5 text-xs disabled:opacity-50">{busy === packageRow.id ? "Opening…" : "Pay with Paystack"}</button></div></div></article>)}</div></section>}<section className="mt-6"><h2 className="text-lg font-bold text-white">Request history</h2>{loading && <p className="mt-3 text-sm text-slate-400">Loading…</p>}{!loading && requests.length === 0 && <p className="mt-3 text-sm text-slate-500">No requests yet.</p>}{requests.length > 0 && <ul className="mt-3 space-y-2">{requests.map((request) => <li key={request.id} className="rounded-xl border border-white/10 px-3 py-3 text-sm text-slate-300">{request.status} · {new Date(request.createdAt).toLocaleDateString()}</li>)}</ul>}</section></main>;
}
