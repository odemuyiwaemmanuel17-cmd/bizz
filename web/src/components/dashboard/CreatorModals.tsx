import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "../../lib/supabase";

export interface CreatorProfileForm {
  username: string;
  display_name: string;
  bio: string;
  avatar_url: string;
  campus: string;
  state: string;
  country: string;
  creator_type: string;
}

export interface CreatorProfileData extends CreatorProfileForm {
  id: string;
  is_verified: boolean;
}

const EMPTY_FORM: CreatorProfileForm = {
  username: "", display_name: "", bio: "", avatar_url: "", campus: "", state: "", country: "", creator_type: "",
};

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_]/g, "");
}

function ModalShell({ title, children, onClose }: { title: string; children: ReactElement; onClose: () => void }): ReactElement {
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="creator-modal-title">
    <div className="my-auto max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-slate-950 p-6 shadow-2xl">
      <div className="sticky top-0 z-10 mb-5 flex items-center justify-between gap-4 bg-slate-950 pb-2"><h2 id="creator-modal-title" className="text-xl font-bold text-white">{title}</h2><button type="button" onClick={onClose} className="text-2xl text-slate-400 hover:text-white" aria-label="Close">×</button></div>
      {children}
    </div>
  </div>;
}

function ProfileFields({ form, setForm, usernameLocked }: { form: CreatorProfileForm; setForm: (next: CreatorProfileForm) => void; usernameLocked?: boolean }): ReactElement {
  const field = (key: keyof CreatorProfileForm, label: string, placeholder = "") => <label className="block text-sm text-slate-300">{label}<input disabled={key === "username" && usernameLocked === true} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} placeholder={placeholder} className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-violet-400" /></label>;
  return <div className="grid gap-3 sm:grid-cols-2">{field("username", "Username", "your_username")}{field("display_name", "Display name")}{field("campus", "Campus")}{field("creator_type", "Creator type", "Designer, developer…")}{field("state", "State")}{field("country", "Country")}
    <label className="text-sm text-slate-300 sm:col-span-2">Avatar URL<input value={form.avatar_url} onChange={(event) => setForm({ ...form, avatar_url: event.target.value })} className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-violet-400" /></label>
    <label className="text-sm text-slate-300 sm:col-span-2">Bio<textarea value={form.bio} maxLength={280} onChange={(event) => setForm({ ...form, bio: event.target.value })} rows={3} className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-violet-400" /></label>
  </div>;
}

export function ProfileModal({ user, initial, setupOnly, onSaved, onClose }: { user: User; initial: CreatorProfileData | null; setupOnly?: boolean; onSaved: (profile: CreatorProfileData) => void; onClose: () => void }): ReactElement {
  const [form, setFormState] = useState<CreatorProfileForm>(initial ?? { ...EMPTY_FORM, display_name: String(user.user_metadata?.["full_name"] ?? "") });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const setForm = (next: CreatorProfileForm): void => setFormState(next);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setError(null);
    const username = normalizeUsername(form.username);
    if (!/^[a-z0-9_]{3,30}$/.test(username)) { setError("Username must be 3–30 characters using letters, numbers, or underscores."); return; }
    const sb = getSupabase(); if (sb === null) { setError("Supabase is not configured."); return; }
    setBusy(true);
    try {
      const duplicate = await sb.from("profiles").select("id").eq("username", username).neq("id", user.id).maybeSingle();
      if (duplicate.error !== null) throw new Error(duplicate.error.message);
      if (duplicate.data !== null) throw new Error("That username is already taken.");
      const payload = { username, display_name: form.display_name.trim() || null, bio: form.bio.trim() || null, avatar_url: form.avatar_url.trim() || null, campus: form.campus.trim() || null, state: form.state.trim() || null, country: form.country.trim() || null, creator_type: form.creator_type.trim() || null };
      const result = await sb.from("profiles").update(payload).eq("id", user.id).select("*").single();
      if (result.error !== null || result.data === null) throw new Error(result.error?.message ?? "Profile could not be saved.");
      onSaved({ id: user.id, username, display_name: form.display_name.trim(), bio: form.bio.trim(), avatar_url: form.avatar_url.trim(), campus: form.campus.trim(), state: form.state.trim(), country: form.country.trim(), creator_type: form.creator_type.trim(), is_verified: Boolean((result.data as { is_verified?: boolean }).is_verified) });
    } catch (err) { setError(err instanceof Error ? err.message : "Profile could not be saved."); } finally { setBusy(false); }
  }
  return <ModalShell title={setupOnly ? "Set up your username" : "Edit creator profile"} onClose={onClose}><form onSubmit={(event) => void submit(event)} className="space-y-4"><ProfileFields form={form} setForm={setForm} /><p className="text-xs text-slate-500">Your username becomes your public profile address: /@username</p>{error !== null && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-glass">Cancel</button><button type="submit" disabled={busy} className="btn-primary">{busy ? "Saving…" : "Save profile"}</button></div></form></ModalShell>;
}

export function VideoUploadModal({ user, onPublished, onClose }: { user: User; onPublished: () => void; onClose: () => void }): ReactElement {
  const [file, setFile] = useState<File | null>(null); const [caption, setCaption] = useState(""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => { if (preview !== null) URL.revokeObjectURL(preview); }, [preview]);
  function choose(next: File | null): void { setError(null); if (next === null) return; if (!next.type.startsWith("video/")) { setError("Choose a video file."); return; } if (next.size > 100 * 1024 * 1024) { setError("Video must be 100 MB or smaller."); return; } setFile(next); setPreview(URL.createObjectURL(next)); }
  async function publish(event: FormEvent): Promise<void> { event.preventDefault(); if (file === null) { setError("Choose a video before publishing."); return; } const sb = getSupabase(); if (sb === null) { setError("Supabase is not configured."); return; } setBusy(true); setError(null);
    try { const path = `${user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`; const uploaded = await sb.storage.from("creator-videos").upload(path, file, { contentType: file.type, upsert: false }); if (uploaded.error !== null) throw new Error(`Video storage upload failed: ${uploaded.error.message}`); const url = sb.storage.from("creator-videos").getPublicUrl(path).data.publicUrl; const inserted = await sb.from("creator_videos").insert({ user_id: user.id, storage_path: path, video_url: url, caption: caption.trim() || null }).select("id").single(); if (inserted.error !== null) throw new Error(`Video record could not be published: ${inserted.error.message}`); onPublished(); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Video could not be published."); } finally { setBusy(false); }
  }
  return <ModalShell title="Upload video" onClose={onClose}><form onSubmit={(event) => void publish(event)} className="space-y-4"><input type="file" accept="video/*" onChange={(event) => choose(event.target.files?.[0] ?? null)} className="block w-full rounded-xl border border-dashed border-white/20 p-4 text-sm text-slate-300" />{preview !== null && <video controls src={preview} className="max-h-56 w-full rounded-xl bg-black" />}<label className="block text-sm text-slate-300">Caption<textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={280} rows={3} className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white" /></label>{error !== null && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-glass">Cancel</button><button type="submit" disabled={busy} className="btn-primary">{busy ? "Publishing…" : "Publish video"}</button></div></form></ModalShell>;
}
