import { useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../components/ui/Toaster";

export default function SettingsPage(): ReactElement {
  const { isAuthenticated, user, signOut } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    await signOut();
    toast.push({ title: "Signed out", description: "Your drafts stay put — see you soon 👋", tone: "info" });
    setBusy(false);
  }

  if (!isAuthenticated) {
    return <main className="mx-auto max-w-2xl px-4 pb-16 pt-32"><section className="glass rounded-3xl p-8 text-center"><h1 className="text-2xl font-bold text-white">Sign in required</h1><p className="mt-2 text-sm text-slate-400">Sign in to manage your account settings.</p><Link to="/auth?next=%2Fdashboard%2Fsettings" className="btn-primary mt-5 inline-block">Go to sign in</Link></section></main>;
  }

  return <main className="mx-auto max-w-3xl px-4 pb-16 pt-32"><div className="mb-7"><Link to="/dashboard" className="text-sm text-slate-400 hover:text-white">← Dashboard</Link><p className="mt-5 text-sm font-medium text-cyan-200">Account</p><h1 className="mt-1 text-3xl font-black text-white">Settings</h1><p className="mt-2 text-sm text-slate-400">Manage your account access and creator profile.</p></div><section className="glass rounded-3xl p-6"><div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5"><div><h2 className="font-semibold text-white">Creator profile</h2><p className="mt-1 text-sm text-slate-500">Update your public identity, bio, and location.</p></div><Link to="/dashboard/profile/edit" className="btn-glass px-4 py-2 text-sm">Edit Profile</Link></div><div className="flex flex-wrap items-center justify-between gap-4 pt-5"><div><h2 className="font-semibold text-white">Signed-in account</h2><p className="mt-1 text-sm text-slate-500">Your authenticated HustleHub account.</p></div><span className="max-w-full truncate text-sm text-slate-300">{user?.email ?? "Signed in"}</span></div><div className="mt-5 border-t border-white/10 pt-5"><button type="button" disabled={busy} onClick={() => void handleSignOut()} className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm font-semibold text-rose-100 disabled:opacity-50">{busy ? "Signing out…" : "Sign out"}</button></div></section></main>;
}
