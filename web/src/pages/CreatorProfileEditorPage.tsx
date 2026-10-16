import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../components/ui/Toaster";
import { useAuth } from "../hooks/useAuth";
import {
  creatorProfileFromRow,
  EMPTY_CREATOR_PROFILE_FORM,
  profileFormFromData,
  saveCreatorProfile,
  type CreatorProfileForm,
  type CreatorProfileRow,
} from "../lib/creator";
import { getSupabase } from "../lib/supabase";

export interface CreatorProfileEditorPageProps {
  readonly mode: "setup" | "edit";
}

function PageHeader(): ReactElement {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <Link to="/dashboard" className="text-sm font-semibold text-slate-300 transition hover:text-white">
        ← Back to dashboard
      </Link>
      <span className="rounded-full border border-violetGlow/30 bg-violetGlow/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-violet-200">
        Creator profile
      </span>
    </div>
  );
}

function ProfileFields({ form, onChange, disabled }: { readonly form: CreatorProfileForm; readonly onChange: (next: CreatorProfileForm) => void; readonly disabled: boolean }): ReactElement {
  const field = (key: keyof CreatorProfileForm, label: string, placeholder = ""): ReactElement => (
    <label className="block text-sm text-slate-300">
      <span>{label}</span>
      <input
        value={form[key]}
        onChange={(event) => onChange({ ...form, [key]: event.target.value })}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {field("username", "Username", "your_username")}
      {field("display_name", "Display name", "How people should recognize you")}
      {field("campus", "Campus")}
      {field("creator_type", "Creator type", "Designer, developer…")}
      {field("state", "State")}
      {field("country", "Country")}
      <label className="block text-sm text-slate-300 sm:col-span-2">
        <span>Avatar URL</span>
        <input
          type="url"
          value={form.avatar_url}
          onChange={(event) => onChange({ ...form, avatar_url: event.target.value })}
          placeholder="https://…"
          disabled={disabled}
          className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>
      <label className="block text-sm text-slate-300 sm:col-span-2">
        <span>Bio</span>
        <textarea
          value={form.bio}
          maxLength={280}
          rows={4}
          onChange={(event) => onChange({ ...form, bio: event.target.value })}
          placeholder="Tell the community what you create."
          disabled={disabled}
          className="mt-1 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="mt-1 block text-right text-xs text-slate-500">{form.bio.length}/280</span>
      </label>
    </div>
  );
}

export default function CreatorProfileEditorPage({ mode }: CreatorProfileEditorPageProps): ReactElement {
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthenticated, status, user } = useAuth();
  const [checking, setChecking] = useState<boolean>(true);
  const [loadingProfile, setLoadingProfile] = useState<boolean>(true);
  const [form, setForm] = useState<CreatorProfileForm>({ ...EMPTY_CREATOR_PROFILE_FORM });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    if (status === "config-missing") {
      setChecking(false);
      return;
    }
    if (isAuthenticated && user !== null) {
      setChecking(false);
      return;
    }
    const timer: number = window.setTimeout(() => {
      if (!isAuthenticated) navigate("/auth", { replace: true });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, navigate, status, user]);

  useEffect(() => {
    if (!isAuthenticated || user === null) return;
    const currentUser = user;
    let active = true;
    async function loadProfile(): Promise<void> {
      setLoadingProfile(true);
      setError(null);
      const sb = getSupabase();
      if (sb === null) {
        if (active) {
          setError("Supabase is not configured.");
          setLoadingProfile(false);
        }
        return;
      }
      try {
        const result = await sb.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
        if (result.error !== null) throw new Error(result.error.message);
        if (active) {
          const profile = creatorProfileFromRow((result.data as CreatorProfileRow | null) ?? null);
          setForm(profileFormFromData(profile, currentUser));
          setLoadingProfile(false);
        }
      } catch (loadError: unknown) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Profile could not be loaded.");
          setForm(profileFormFromData(null, currentUser));
          setLoadingProfile(false);
        }
      }
    }
    void loadProfile();
    return () => {
      active = false;
    };
  }, [isAuthenticated, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (user === null) {
      setError("Sign in before editing your creator profile.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await saveCreatorProfile(user, form);
      toast.push({
        title: mode === "setup" ? "Creator profile ready 🎉" : "Profile saved",
        description: "Your public creator identity is up to date.",
        tone: "success",
      });
      navigate("/dashboard", { replace: true });
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : "Profile could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (checking && status !== "config-missing") {
    return <div className="flex min-h-screen items-center justify-center px-4 pt-24 text-sm text-slate-400">Checking your session…</div>;
  }

  if (!isAuthenticated || user === null) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 pb-16 pt-32">
        <section className="glass w-full max-w-md rounded-3xl p-8 text-center">
          <h1 className="text-xl font-bold text-white">Profile setup needs an account</h1>
          <p className="mt-2 text-sm text-slate-400">
            {status === "config-missing" ? "Supabase is not configured in this build." : "Sign in to manage your creator profile."}
          </p>
          <Link to="/auth" className="btn-primary mt-5 inline-block">Go to sign in</Link>
        </section>
      </main>
    );
  }

  const title = mode === "setup" ? "Set up your creator profile" : "Edit creator profile";
  const description = mode === "setup"
    ? "Choose how the HustleHub community will find and remember you."
    : "Keep your public creator identity current across HustleHub.";
  const disabled = loadingProfile || busy;

  return (
    <main className="min-h-screen px-4 pb-20 pt-32 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader />
        <section className="glass rounded-3xl p-6 shadow-xl shadow-black/30 sm:p-8">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-black tracking-tight text-white">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
          </div>

          {loadingProfile ? (
            <p className="mt-8 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-400">Loading your profile…</p>
          ) : (
            <form onSubmit={(event) => void handleSubmit(event)} className="mt-8 space-y-6" noValidate>
              <ProfileFields form={form} onChange={setForm} disabled={disabled} />
              <p className="text-xs text-slate-500">Your username becomes your public profile address: /@username</p>
              {error !== null && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
              <div className="flex flex-wrap justify-end gap-3 border-t border-white/10 pt-5">
                <Link to="/dashboard" className="btn-glass">Cancel</Link>
                <button type="submit" disabled={disabled} className="btn-primary disabled:cursor-not-allowed disabled:opacity-60">
                  {busy ? "Saving…" : mode === "setup" ? "Create profile" : "Save profile"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
