import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitBizzEvent } from "../lib/events";
import {
  EMPTY_DRAFT,
  FORM_STEPS,
  validateAndPreviewImage,
  validateDraftStep,
  releaseImagePreview,
  uploadListingImage,
  publishListing,
  type DraftErrors,
  type ListingDraft,
  type PublishResult,
  type PublishedListing,
  type ValidatedImage,
} from "../lib/ideas";
import { useAuth } from "./useAuth";

export interface UsePostBizzResult {
  readonly steps: ReadonlyArray<string>;
  readonly stepIndex: number;
  readonly draft: ListingDraft;
  readonly errors: DraftErrors;
  readonly image: ValidatedImage | null;
  readonly imageError: string | null;
  readonly uploading: boolean;
  readonly uploadPercent: number;
  readonly submitting: boolean;
  readonly submitError: string | null;
  readonly published: PublishedListing | null;
  readonly canGoNext: boolean;
  readonly updateDraft: (patch: Partial<ListingDraft>) => void;
  readonly attachImage: (file: File | null) => void;
  readonly detachImage: () => void;
  readonly next: () => void;
  readonly back: () => void;
  readonly goToStep: (index: number) => void;
  readonly submit: () => Promise<void>;
  readonly reset: () => void;
}

/**
 * State machine behind the "Post a Bizz" wizard: per-step validation,
 * Supabase Storage upload with progress, and final publish. All async work is
 * cancellation-safe (unmount / reset guarded via a generation counter).
 */
export function usePostBizz(): UsePostBizzResult {
  const auth = useAuth();
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [draft, setDraft] = useState<ListingDraft>(EMPTY_DRAFT);
  const [image, setImage] = useState<ValidatedImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishedListing | null>(null);
  const generationRef = useRef<number>(0);
  const previewRef = useRef<string | null>(null);

  // Revoke any live object URL on unmount to avoid leaks.
  useEffect(() => {
    return (): void => {
      generationRef.current += 1;
      releaseImagePreview(previewRef.current);
      previewRef.current = null;
    };
  }, []);

  const errors: DraftErrors = useMemo(
    (): DraftErrors => validateDraftStep(draft, stepIndex),
    [draft, stepIndex],
  );

  const updateDraft = useCallback((patch: Partial<ListingDraft>): void => {
    setSubmitError(null);
    setDraft((prev: ListingDraft): ListingDraft => Object.freeze({ ...prev, ...patch }));
  }, []);

  const attachImage = useCallback((file: File | null): void => {
    releaseImagePreview(previewRef.current);
    previewRef.current = null;
    if (file === null) {
      setImage(null);
      setImageError(null);
      return;
    }
    const result = validateAndPreviewImage(file);
    if (result.ok) {
      setImage(result.value);
      setImageError(null);
      previewRef.current = result.value.previewUrl;
    } else {
      setImage(null);
      setImageError(result.message);
    }
  }, []);

  const detachImage = useCallback((): void => {
    attachImage(null);
    setDraft((prev: ListingDraft): ListingDraft => Object.freeze({ ...prev, imageUrl: null }));
    setUploadPercent(0);
  }, [attachImage]);

  const goToStep = useCallback((index: number): void => {
    const clamped: number = Math.min(FORM_STEPS.length - 1, Math.max(0, Math.trunc(index)));
    setStepIndex(clamped);
    setSubmitError(null);
  }, []);

  const back = useCallback((): void => {
    goToStep(stepIndex - 1);
  }, [goToStep, stepIndex]);

  const next = useCallback((): void => {
    const stepErrors: DraftErrors = validateDraftStep(draft, stepIndex);
    if (Object.keys(stepErrors).length > 0) return; // block forward navigation
    goToStep(stepIndex + 1);
  }, [draft, stepIndex, goToStep]);

  const submit = useCallback(async (): Promise<void> => {
    if (submitting || published !== null) return;
    const generation: number = ++generationRef.current;
    setSubmitting(true);
    setSubmitError(null);

    try {
      let imageUrl: string | null = draft.imageUrl;

      // Step 1 — upload the picked file to Supabase Storage (if any).
      if (image !== null && imageUrl === null) {
        setUploading(true);
        setUploadPercent(0);
        const userId: string = auth.user?.id ?? "guest";
        const outcome = await uploadListingImage(image.file, userId, (progress) => {
          if (generationRef.current !== generation) return;
          const pct: number = progress.totalBytes > 0 ? Math.round((progress.loadedBytes / progress.totalBytes) * 100) : 0;
          setUploadPercent(Math.min(100, pct));
        });
        setUploading(false);
        if (generationRef.current !== generation) return;
        if (!outcome.ok) {
          setSubmitError(outcome.message);
          setSubmitting(false);
          return;
        }
        imageUrl = outcome.publicUrl;
        setDraft((prev: ListingDraft): ListingDraft => Object.freeze({ ...prev, imageUrl }));
      }

      // Step 2 — publish (concept → ideas table, concrete → listings table).
      const finalDraft: ListingDraft = Object.freeze({ ...draft, imageUrl });
      const result: PublishResult<PublishedListing> = await publishListing(finalDraft);
      if (generationRef.current !== generation) return;
      if (result.ok) {
        setPublished(result.value);
        // Post → dashboard/marketplace sync: tell every mounted data hook the
        // cache is stale so the new bizz appears immediately (no manual
        // refresh needed). BroadcastChannel also covers other open tabs.
        emitBizzEvent({ kind: "published", id: result.value.id, isConcept: result.value.isConcept });
      } else {
        setSubmitError(result.message);
      }
    } catch (err: unknown) {
      if (generationRef.current !== generation) return;
      setSubmitError(err instanceof Error ? err.message : "Something went wrong while publishing.");
    } finally {
      if (generationRef.current === generation) setSubmitting(false);
    }
  }, [auth.user?.id, draft, image, published, submitting]);

  const reset = useCallback((): void => {
    generationRef.current += 1;
    releaseImagePreview(previewRef.current);
    previewRef.current = null;
    setStepIndex(0);
    setDraft(EMPTY_DRAFT);
    setImage(null);
    setImageError(null);
    setUploading(false);
    setUploadPercent(0);
    setSubmitting(false);
    setSubmitError(null);
    setPublished(null);
  }, []);

  const canGoNext: boolean =
    stepIndex < FORM_STEPS.length - 1
      ? Object.keys(errors).length === 0
      : !submitting && !uploading && published === null;

  return {
    steps: FORM_STEPS,
    stepIndex,
    draft,
    errors,
    image,
    imageError,
    uploading,
    uploadPercent,
    submitting,
    submitError,
    published,
    canGoNext,
    updateDraft,
    attachImage,
    detachImage,
    next,
    back,
    goToStep,
    submit,
    reset,
  };
}
