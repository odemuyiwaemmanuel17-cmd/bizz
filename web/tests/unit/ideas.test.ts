/**
 * Phase 4 unit tests (Vitest). Covers the pure logic behind the "Post a Bizz"
 * wizard validation and the Bizz/Fizz sentiment tallies. The Supabase-backed
 * paths are exercised via `vite build` + manual QA; offline demo mode keeps
 * them deterministic without network access.
 */

import { describe, it, expect } from "vitest";

import {
  computeTally,
  isValidated,
  validateDraft,
  validateDraftStep,
  EMPTY_DRAFT,
  VALIDATION_THRESHOLD_BIZZ,
  type ListingDraft,
} from "../../src/lib/ideas";

describe("computeTally", () => {
  it("reports whole-number percentages that sum to exactly 100", () => {
    const tally = computeTally(78, 22);
    expect(tally.bizzPercent).toBe(78);
    expect(tally.fizzPercent).toBe(22);
    expect(tally.bizzPercent + tally.fizzPercent).toBe(100);
  });

  it("rounds thirds without losing the remainder", () => {
    const tally = computeTally(1, 2); // 33.33% bizz
    expect(tally.bizzPercent).toBe(33);
    expect(tally.fizzPercent).toBe(67);
  });

  it("handles the empty ledger and dirty inputs", () => {
    const empty = computeTally(0, 0);
    expect(empty).toEqual({ bizz: 0, fizz: 0, total: 0, bizzPercent: 0, fizzPercent: 0 });
    const dirty = computeTally(-5, Number.NaN);
    expect(dirty.total).toBe(0);
    const huge = computeTally(1_000_000, 1);
    expect(huge.bizzPercent).toBe(100);
    expect(huge.fizzPercent).toBe(0);
  });
});

describe("isValidated", () => {
  it("requires both volume and sentiment thresholds", () => {
    const strong = computeTally(VALIDATION_THRESHOLD_BIZZ, 10); // ~83% bizz
    expect(isValidated(strong)).toBe(true);
    const weakVolume = computeTally(VALIDATION_THRESHOLD_BIZZ - 1, 1);
    expect(isValidated(weakVolume)).toBe(false);
    const weakSentiment = computeTally(60, 60); // enough voters, only 50% bizz
    expect(isValidated(weakSentiment)).toBe(false);
  });
});

describe("validateDraft / validateDraftStep", () => {
  const goodPitch = "Brutally honest resume feedback in 24 hours from real recruiters.";

  it("rejects too-short titles and short blurbs", () => {
    const draft: ListingDraft = Object.freeze({ ...EMPTY_DRAFT, title: "Hi", blurb: "short" });
    const errors = validateDraft(draft);
    expect(errors.title).toBeDefined();
    expect(errors.blurb).toBeDefined();
  });

  it("accepts a well-formed concrete listing", () => {
    const draft: ListingDraft = Object.freeze({
      ...EMPTY_DRAFT,
      title: "Resume Roast",
      blurb: goodPitch,
      category: "services",
      priceCents: 1500,
    });
    expect(validateDraft(draft)).toEqual({});
  });

  it("blocks step 0 navigation until the title is valid", () => {
    expect(validateDraftStep(EMPTY_DRAFT, 0).title).toBeDefined();
    const fixed: ListingDraft = Object.freeze({ ...EMPTY_DRAFT, title: "Good title" });
    expect(validateDraftStep(fixed, 0)).toEqual({});
    // Step 1 still guards the blurb even when step 0 passes.
    expect(validateDraftStep(fixed, 1).blurb).toBeDefined();
  });

  it("rejects negative or absurd prices", () => {
    const base: ListingDraft = Object.freeze({ ...EMPTY_DRAFT, title: "Fine title", blurb: goodPitch });
    expect(validateDraft(Object.freeze({ ...base, priceCents: -100 })).priceCents).toBeDefined();
    expect(validateDraft(Object.freeze({ ...base, priceCents: 20_000_00 })).priceCents).toBeDefined();
    expect(validateDraft(Object.freeze({ ...base, priceCents: Number.NaN })).priceCents).toBeDefined();
  });

  it("lets concept drafts skip the pitch entirely", () => {
    const concept: ListingDraft = Object.freeze({ ...EMPTY_DRAFT, title: "Idea name", blurb: "", isConcept: true });
    expect(validateDraft(concept)).toEqual({});
  });

  it("ignores media/review steps for field errors", () => {
    expect(validateDraftStep(EMPTY_DRAFT, 2)).toEqual({});
    expect(validateDraftStep(EMPTY_DRAFT, 3)).toEqual({});
  });
});
