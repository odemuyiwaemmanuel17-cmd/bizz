import { test } from "vitest";
import assert from "node:assert/strict";

import { creatorProfilePath, normalizeProfileUsername } from "../src/lib/creator";

test("public profile usernames normalize the route @ prefix and casing", () => {
  assert.strictEqual(normalizeProfileUsername("@Creator_Name"), "creator_name");
  assert.strictEqual(normalizeProfileUsername(" creator_name "), "creator_name");
});

test("creator profile paths prefer the canonical username", () => {
  assert.strictEqual(creatorProfilePath("@Creator_Name", "profile-1"), "/@creator_name");
});

test("creator profile paths fall back to the stable profile id", () => {
  assert.strictEqual(creatorProfilePath(null, "profile-1"), "/creator/profile-1");
});
