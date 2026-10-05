import { useEffect, type ReactElement } from "react";
import { usePostBizz } from "../../hooks/usePostBizz";
import { useAuth } from "../../hooks/useAuth";
import { formatPrice, CATEGORY_TABS, type FeedCategory } from "../../lib/feed";
import { normalizeContactLink } from "../../lib/contact";
import { VALIDATION_THRESHOLD_BIZZ } from "../../lib/ideas";
import { useToast, type ToastApi, type ToastInput } from "../ui/Toaster";
import type { PublishedListing } from "../../lib/ideas";

interface PostBizzModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-cyanGlow/60 focus:bg-white/10";

/** Announces publish success once per published listing (guarded by ref id). */
function usePublishAnnouncement(
  wizard: { readonly published: PublishedListing | null },
  toast: ToastApi,
): void {
  const published = wizard.published;
  useEffect(() => {
    if (published === null) return;
    const input: ToastInput = published.isConcept
      ? {
          title: "Concept dropped into validation 💡",
          description: `“${published.title}” is now collecting Bizz/Fizz votes.`,
          tone: "success",
        }
      : {
          title: "Bizz is live on the feed 🚀",
          description: `“${published.title}” is discoverable in the marketplace.`,
          tone: "success",
        };
    toast.push(input);
    // Runs only when a *new* publication lands (id changes or goes non-null).
  }, [published?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

function StepDots({ steps, current }: { steps: ReadonlyArray<string>; current: number }): ReactElement {
  return (
    <ol className="flex items-center gap-2" aria-label="Form progress">
      {steps.map((label: string, index: number) => {
        const state: string = index < current ? "done" : index === current ? "active" : "todo";
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={state === "active" ? "step" : undefined}
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                state === "done"
                  ? "bg-cyanGlow/20 text-cyanGlow"
                  : state === "active"
                    ? "bg-gradient-to-r from-indigoGlow to-violetGlow text-white"
                    : "border border-white/15 text-slate-500"
              }`}
            >
              {state === "done" ? "\u2713" : index + 1}
            </span>
            <span className={`hidden text-xs sm:inline ${state === "active" ? "font-semibold text-white" : "text-slate-500"}`}>
              {label}
            </span>
            {index < steps.length - 1 && <span className="h-px w-4 bg-white/10" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Phase 4 — "Post a Bizz" multi-step wizard (protected: requires auth when
 * Supabase is configured; demo mode allows the full flow offline).
 */
export default function PostBizzModal({ open, onClose }: PostBizzModalProps): ReactElement | null {
  const auth = useAuth();
  const wizard = usePostBizz();
  const toast = useToast();

  usePublishAnnouncement(wizard, toast);

  // Escape-to-close + body scroll lock while the modal is mounted.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow: string = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const { stepIndex, steps, draft, errors, image, imageError, uploading, uploadPercent, submitting, submitError, published } = wizard;
  const needsAuth: boolean = !auth.isAuthenticated && auth.status !== "config-missing";
  const priceDollars: string = (draft.priceCents / 100).toFixed(2);

  const handleClose = (): void => {
    wizard.reset();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-bizz-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div className="glass max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl p-6 sm:rounded-3xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="post-bizz-title" className="text-xl font-bold text-white">
              Post a Bizz 🚀
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {published !== null
                ? "Nice — your hustle is live."
                : draft.isConcept
                  ? "Concept phase: the community will vote Bizz or Fizz before you build it."
                  : "Publish an offer the community can buy today."}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:border-white/30 hover:text-white"
          >
            ✕
          </button>
        </div>

        {published !== null ? (
          <div className="mt-8 rounded-2xl border border-cyanGlow/30 bg-cyanGlow/10 p-6 text-center">
            <p className="text-3xl" aria-hidden="true">{published.isConcept ? "\uD83E\uDD84" : "\uD83D\uDE80"}</p>
            <h3 className="mt-3 text-lg font-bold text-white">
              {published.isConcept ? "Idea dropped into validation!" : "Bizz is live on the feed!"}
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-slate-300">
              “{published.title}” {published.isConcept ? "now needs Bizz/Fizz votes from the community." : "is discoverable in the marketplace."}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button type="button" onClick={wizard.reset} className="btn-glass">
                Post another
              </button>
              <button
                type="button"
                onClick={() => {
                  handleClose();
                  const el: HTMLElement | null = document.getElementById("dashboard");
                  if (el !== null) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="btn-primary"
              >
                View in dashboard →
              </button>
            </div>
          </div>
        ) : needsAuth ? (
          <div className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-6 text-center">
            <p className="text-lg font-semibold text-white">Sign in to post</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-amber-100/80">
              Use the magic-link sign-in in the navbar — publishing hooks into your creator profile and Supabase Storage.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-6">
              <StepDots steps={steps} current={stepIndex} />
            </div>

            <form
              className="mt-6 flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (stepIndex < steps.length - 1) wizard.next();
                else void wizard.submit();
              }}
            >
              {stepIndex === 0 && (
                <>
                  <fieldset className="flex gap-3">
                    <legend className="sr-only">What stage is this at?</legend>
                    {[false, true].map((isConcept: boolean) => (
                      <label
                        key={String(isConcept)}
                        className={`flex-1 cursor-pointer rounded-2xl border p-4 text-sm transition ${
                          draft.isConcept === isConcept
                            ? "border-cyanGlow/60 bg-cyanGlow/10 text-white"
                            : "border-white/10 bg-white/5 text-slate-400 hover:border-white/25"
                        }`}
                      >
                        <input
                          type="radio"
                          name="stage"
                          className="sr-only"
                          checked={draft.isConcept === isConcept}
                          onChange={() => wizard.updateDraft({ isConcept })}
                        />
                        <span className="block text-base font-bold">{isConcept ? "\uD83D\uDCA1 Concept" : "\uD83D\uDC0E Ready to sell"}</span>
                        <span className="mt-1 block text-xs leading-relaxed">
                          {isConcept
                            ? "Test the idea first — collect Bizz/Fizz votes before building."
                            : "Launch straight onto the marketplace feed with a price tag."}
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <div>
                    <label htmlFor="bizz-title" className="mb-1.5 block text-sm font-semibold text-slate-200">
                      Title
                    </label>
                    <input
                      id="bizz-title"
                      className={inputClass}
                      placeholder="e.g. Resume Roast — recruiter-grade feedback in 24h"
                      value={draft.title}
                      maxLength={90}
                      onChange={(event) => wizard.updateDraft({ title: event.target.value })}
                      autoFocus
                    />
                    {errors.title !== undefined && <p role="alert" className="mt-1.5 text-xs text-rose-300">{errors.title}</p>}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="bizz-category" className="mb-1.5 block text-sm font-semibold text-slate-200">
                        Category
                      </label>
                      <select
                        id="bizz-category"
                        className={inputClass}
                        value={draft.category}
                        onChange={(event) => wizard.updateDraft({ category: event.target.value as FeedCategory })}
                      >
                        {CATEGORY_TABS.filter((tab) => tab.id !== "all").map((tab) => (
                          <option key={tab.id} value={tab.id} className="bg-slate-900">
                            {tab.label}
                          </option>
                        ))}
                      </select>
                      {errors.category !== undefined && <p role="alert" className="mt-1.5 text-xs text-rose-300">{errors.category}</p>}
                    </div>
                    <div>
                      <label htmlFor="bizz-price" className="mb-1.5 block text-sm font-semibold text-slate-200">
                        Price (USD) {draft.isConcept ? "— target price" : ""}
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                        <input
                          id="bizz-price"
                          type="number"
                          min={0}
                          max={10000}
                          step={0.5}
                          inputMode="decimal"
                          className={`${inputClass} pl-8`}
                          placeholder="0.00"
                          value={draft.priceCents === 0 ? "" : priceDollars}
                          onChange={(event) => {
                            const parsed: number = Math.round((Number.parseFloat(event.target.value || "0") || 0) * 100);
                            wizard.updateDraft({ priceCents: Math.max(0, parsed) });
                          }}
                        />
                      </div>
                      {errors.priceCents !== undefined && (
                        <p role="alert" className="mt-1.5 text-xs text-rose-300">{errors.priceCents}</p>
                      )}
                    </div>
                  </div>
                </>
              )}

              {stepIndex === 1 && (
                <div>
                  <label htmlFor="bizz-blurb" className="mb-1.5 block text-sm font-semibold text-slate-200">
                    One-line pitch
                  </label>
                  <textarea
                    id="bizz-blurb"
                    rows={4}
                    className={`${inputClass} resize-none`}
                    placeholder={
                      draft.isConcept
                        ? "What problem does this solve, and how would it work?"
                        : "What exactly does the buyer get, and how fast?"
                    }
                    value={draft.blurb}
                    maxLength={300}
                    onChange={(event) => wizard.updateDraft({ blurb: event.target.value })}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    {errors.blurb !== undefined ? (
                      <p role="alert" className="text-xs text-rose-300">{errors.blurb}</p>
                    ) : (
                      <span className="text-xs text-slate-500">Keep it punchy — cards show two lines.</span>
                    )}
                    <span className={`text-xs tabular-nums ${draft.blurb.length > 280 ? "text-rose-300" : "text-slate-500"}`}>
                      {draft.blurb.length}/280
                    </span>
                  </div>

                  {/* Contact link (stored in listings.contact_link, NOT NULL) */}
                  {!draft.isConcept && (
                    <div className="mt-6">
                      <span className="mb-1.5 block text-sm font-semibold text-slate-200">
                        How should buyers contact you?
                      </span>
                      <div className="mb-2 inline-flex rounded-xl border border-white/10 bg-white/5 p-1" role="radiogroup" aria-label="Contact channel">
                        {(["whatsapp", "telegram"] as const).map((channel) => (
                          <button
                            key={channel}
                            type="button"
                            role="radio"
                            aria-checked={draft.contactChannel === channel}
                            onClick={() => wizard.updateDraft({ contactChannel: channel })}
                            className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${
                              draft.contactChannel === channel
                                ? "bg-gradient-to-r from-cyanGlow/30 to-violetGlow/30 text-white"
                                : "text-slate-400 hover:text-white"
                            }`}
                          >
                            {channel === "whatsapp" ? "💬 WhatsApp" : "✈️ Telegram"}
                          </button>
                        ))}
                      </div>
                      <label htmlFor="bizz-contact" className="sr-only">
                        {draft.contactChannel === "whatsapp" ? "WhatsApp phone number" : "Telegram username"}
                      </label>
                      <input
                        id="bizz-contact"
                        type="text"
                        inputMode={draft.contactChannel === "whatsapp" ? "tel" : "text"}
                        autoComplete="off"
                        className={inputClass}
                        placeholder={
                          draft.contactChannel === "whatsapp"
                            ? "+14155550123 or https://wa.me/14155550123"
                            : "@yourhandle or https://t.me/yourhandle"
                        }
                        value={draft.contactHandle}
                        onChange={(event) => wizard.updateDraft({ contactHandle: event.target.value })}
                      />
                      {errors.contactHandle !== undefined ? (
                        <p role="alert" className="mt-1.5 text-xs text-rose-300">{errors.contactHandle}</p>
                      ) : (
                        <p className="mt-1.5 text-xs text-slate-500">
                          Optional — saved as the listing&rsquo;s contact link. Leave blank and buyers reach you via your profile chat CTA.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {stepIndex === 2 && (
                <div>
                  <span className="mb-1.5 block text-sm font-semibold text-slate-200">Cover image (optional)</span>
                  {image !== null ? (
                    <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                      <img src={image.previewUrl} alt="Selected cover preview" className="h-20 w-20 rounded-xl object-cover" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{image.file.name}</p>
                        <p className="mt-0.5 text-xs text-slate-400">{(image.file.size / 1024).toFixed(0)} KB · uploads to Supabase Storage on publish</p>
                        {uploading && (
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={uploadPercent} aria-valuemin={0} aria-valuemax={100}>
                            <div className="h-full rounded-full bg-gradient-to-r from-cyanGlow to-violetGlow transition-all" style={{ width: `${uploadPercent}%` }} />
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={wizard.detachImage} className="btn-glass shrink-0 !px-3 !py-1.5 text-xs">
                        Remove
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 bg-white/5 p-8 text-center transition hover:border-cyanGlow/50 hover:bg-white/10">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="sr-only"
                        onChange={(event) => wizard.attachImage(event.target.files?.[0] ?? null)}
                      />
                      <span className="text-2xl" aria-hidden="true">🖼️</span>
                      <span className="text-sm font-medium text-slate-200">Drop or browse an image</span>
                      <span className="text-xs text-slate-500">PNG, JPG, WEBP or GIF · up to 5 MB</span>
                    </label>
                  )}
                  {imageError !== null && <p role="alert" className="mt-2 text-xs text-rose-300">{imageError}</p>}
                </div>
              )}

              {stepIndex === 3 && (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                    <dt className="text-slate-500">Stage</dt>
                    <dd className="font-medium text-white">{draft.isConcept ? "💡 Concept — Bizz or Fizz validation" : "📌 Live listing"}</dd>
                    <dt className="text-slate-500">Title</dt>
                    <dd className="font-medium text-white">{draft.title.trim() || "—"}</dd>
                    <dt className="text-slate-500">Pitch</dt>
                    <dd className="text-slate-300">{draft.blurb.trim() || "—"}</dd>
                    <dt className="text-slate-500">Category</dt>
                    <dd className="font-medium capitalize text-white">{draft.category}</dd>
                    <dt className="text-slate-500">Price</dt>
                    <dd className="font-medium text-white">{formatPrice(draft.priceCents, draft.currency)}</dd>
                    {!draft.isConcept && (
                      <>
                        <dt className="text-slate-500">Contact link</dt>
                        <dd className="break-all font-medium text-white">
                          {normalizeContactLink(draft.contactChannel, draft.contactHandle) ?? "— none (saved as blank)"}
                        </dd>
                      </>
                    )}
                    <dt className="text-slate-500">Image</dt>
                    <dd className="font-medium text-white">{image !== null ? image.file.name : draft.imageUrl !== null ? "Uploaded" : "None"}</dd>
                  </dl>
                  {draft.isConcept && (
                    <p className="mt-4 rounded-xl bg-violetGlow/10 px-4 py-3 text-xs leading-relaxed text-violet-200">
                      Concepts hit the validation pool. At {VALIDATION_THRESHOLD_BIZZ}+ Bizz votes and ≥60% sentiment they earn a “Validated” badge.
                    </p>
                  )}
                </div>
              )}

              {submitError !== null && (
                <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                  {submitError}
                </p>
              )}

              <div className="mt-2 flex items-center justify-between gap-3">
                <button type="button" onClick={wizard.back} disabled={stepIndex === 0} className="btn-glass disabled:cursor-not-allowed disabled:opacity-40">
                  ← Back
                </button>
                {stepIndex < steps.length - 1 ? (
                  <button type="submit" disabled={!wizard.canGoNext} className="btn-primary disabled:cursor-not-allowed disabled:opacity-40">
                    Continue →
                  </button>
                ) : (
                  <button type="submit" disabled={!wizard.canGoNext || uploading} className="btn-primary disabled:cursor-not-allowed disabled:opacity-40">
                    {uploading ? `Uploading ${uploadPercent}%…` : submitting ? "Publishing…" : draft.isConcept ? "Drop it for validation 💡" : "Publish bizz 🚀"}
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
