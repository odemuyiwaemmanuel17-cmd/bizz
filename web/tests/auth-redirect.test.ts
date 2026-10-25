import { test } from "vitest";
import assert from "node:assert/strict";

import { safeAuthReturnPath } from "../src/lib/authRedirect";

test("auth return paths preserve internal analytics routes", () => {
  assert.strictEqual(safeAuthReturnPath("/dashboard/analytics"), "/dashboard/analytics");
});

test("auth return paths reject external redirects", () => {
  assert.strictEqual(safeAuthReturnPath("https://example.com"), "/dashboard");
  assert.strictEqual(safeAuthReturnPath("//example.com"), "/dashboard");
  assert.strictEqual(safeAuthReturnPath(null, "/dashboard/analytics"), "/dashboard/analytics");
});
