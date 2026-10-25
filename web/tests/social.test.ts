import { test } from "vitest";
import assert from "node:assert/strict";

import { validateCommentBody } from "../src/lib/social";

test("comment validation trims valid text and rejects empty text", () => {
  assert.strictEqual(validateCommentBody("  helpful note  "), "helpful note");
  assert.throws(() => validateCommentBody("   "), /between 1 and 500/);
});

test("comment validation rejects text longer than the database limit", () => {
  assert.throws(() => validateCommentBody("x".repeat(501)), /between 1 and 500/);
});
