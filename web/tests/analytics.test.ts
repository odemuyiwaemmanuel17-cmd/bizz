import { test } from "vitest";
import assert from "node:assert/strict";

import { bizzClickThroughRate, engagementRate } from "../src/lib/analytics";

test("engagement rate uses current likes and saves over tracked video views", () => {
  assert.strictEqual(engagementRate({ videoViews: 100, profileVisits: 0, bizzViews: 0, videoToBizzClicks: 0, contactClicks: 0, likes: 8, saves: 2 }), 10);
});

test("analytics rates safely return zero when there are no views", () => {
  const totals = { videoViews: 0, profileVisits: 4, bizzViews: 2, videoToBizzClicks: 3, contactClicks: 1, likes: 10, saves: 2 };
  assert.strictEqual(engagementRate(totals), 0);
  assert.strictEqual(bizzClickThroughRate(totals), 0);
});

test("Bizz click-through rate uses linked Bizz clicks over video views", () => {
  assert.strictEqual(bizzClickThroughRate({ videoViews: 80, profileVisits: 0, bizzViews: 0, videoToBizzClicks: 4, contactClicks: 0, likes: 0, saves: 0 }), 5);
});
