import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../components/ui/Toaster";
import { useAuth } from "../hooks/useAuth";
import { publishCreatorVideo, validateVideoFile } from "../lib/creator";

export default function CreatorVideoUploadPage(): ReactElement {
  const navigate = useNavigate();
  const toast = useToast();
  const { isAuthenticated, status, user } = useAuth();
  const [checking, setChecking] = useState<boolean>(true);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState<string>("");
  const [preview, setPreview] = useState<string | null>(null);
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
    return () => {
      if (preview !== null) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function chooseFile(next: File | null): void {
    setError(null);
    if (next === null) return;
    const validationError = validateVideoFile(next);
    if (validationError !== null) {
      setError(validationError);
      setFile(null);
      setPreview(null);
      return;
    }
    setFile(next);
    setPreview(URL.createObjectURL(next));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (user === null) {
      setError("Sign in before uploading a video.");
      return;
    }
    if (file === null) {
      setError("Choose a video before publishing.");
      return;
    }
    const validationError = validateVideoFile(file);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await publishCreatorVideo(user, file, caption);
      toast.push({
        title: "Video published 🎬",
        description: "Your video is now on your creator profile.",
        tone: "success",
      });
      navigate("/dashboard", { replace: true });
    } catch (publishError: unknown) {
      setError(publishError instanceof Error ? publishError.message : "Video could not be published.");
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
          <h1 className="text-xl font-bold text-white">Video upload needs an account</h1>
          <p className="mt-2 text-sm text-slate-400">
            {status === "config-missing" ? "Supabase is not configured in this build." : "Sign in to publish a creator video."}
          </p>
          <Link to="/auth" className="btn-primary mt-5 inline-block">Go to sign in</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 pb-20 pt-32 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Link to="/dashboard" className="text-sm font-semibold text-slate-300 transition hover:text-white">← Back to dashboard</Link>
          <span className="rounded-full border border-cyanGlow/30 bg-cyanGlow/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-cyan-200">Creator video</span>
        </div>
        <section className="glass rounded-3xl p-6 shadow-xl shadow-black/30 sm:p-8">
          <h1 className="text-3xl font-black tracking-tight text-white">Upload a creator video</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Share a quick look at what you make, offer, or are building. Videos are published to your public creator profile after the upload and database record both succeed.</p>

          <form onSubmit={(event) => void handleSubmit(event)} className="mt-8 space-y-6">
            <div>
              <label htmlFor="creator-video-file" className="mb-2 block text-sm font-semibold text-slate-200">Video file</label>
              <input
                id="creator-video-file"
                type="file"
                accept="video/*"
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                disabled={busy}
                className="block w-full cursor-pointer rounded-2xl border border-dashed border-white/20 bg-white/5 p-5 text-sm text-slate-300 file:mr-4 file:rounded-full file:border-0 file:bg-violetGlow/20 file:px-4 file:py-2 file:font-semibold file:text-violet-100 hover:border-violet-300/60 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="mt-2 text-xs text-slate-500">MP4, WebM, or another browser-supported video up to 100 MB.</p>
            </div>

            {preview !== null && (
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-2">
                <video controls src={preview} className="max-h-[28rem] w-full rounded-xl bg-black" />
                <p className="px-2 pb-1 pt-3 text-xs text-slate-400">{file?.name}</p>
              </div>
            )}

            <label className="block text-sm text-slate-300">
              <span>Caption</span>
              <textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                maxLength={280}
                rows={4}
                placeholder="What should people know about this video?"
                disabled={busy}
                className="mt-1 w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white outline-none transition placeholder:text-slate-500 focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="mt-1 block text-right text-xs text-slate-500">{caption.length}/280</span>
            </label>

            {error !== null && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
            <div className="flex flex-wrap justify-end gap-3 border-t border-white/10 pt-5">
              <Link to="/dashboard" className="btn-glass">Cancel</Link>
              <button type="submit" disabled={busy} className="btn-primary disabled:cursor-not-allowed disabled:opacity-60">
                {busy ? "Publishing…" : "Publish video"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
