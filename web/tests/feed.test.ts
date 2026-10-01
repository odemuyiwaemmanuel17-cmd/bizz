import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_TABS,
  DEFAULT_PAGE_SIZE,
  FEED_CATEGORIES,
  formatPrice,
  normalizeFeedCategory,
} from "../src/lib/feed";

test("category tabs match the Phase-3 spec exactly", () => {
  assert.deepStrictEqual(FEED_CATEGORIES, ["all", "services", "tech", "campus", "digital"]);
  assert.deepStrictEqual(CATEGORY_TABS.map((tab) => tab.label), ["All", "Services", "Tech", "Campus", "Digital"]);
});

test("normalizeFeedCategory maps legacy schema values onto tabs", () => {
  assert.strictEqual(normalizeFeedCategory("digital-goods"), "digital");
  assert.strictEqual(normalizeFeedCategory("SAAS"), "tech");
  assert.strictEqual(normalizeFeedCategory("physical"), "services");
  assert.strictEqual(normalizeFeedCategory("campus"), "campus");
  assert.strictEqual(normalizeFeedCategory(null), "digital"); // unknown -> safe default
  assert.strictEqual(normalizeFeedCategory("mystery"), "digital");
});

test("formatPrice renders compact price tags", () => {
  assert.strictEqual(formatPrice(1500), "$15");
  assert.strictEqual(formatPrice(1250), "$12.50");
  assert.strictEqual(formatPrice(0), "Free");
  assert.strictEqual(formatPrice(-5), "Free");
  assert.strictEqual(formatPrice(Number.NaN), "Free");
  assert.strictEqual(formatPrice(900, "EUR"), "\u20ac9");
  assert.strictEqual(formatPrice(900, "AUD"), "AUD 9");
});

test("DEFAULT_PAGE_SIZE is sane for card grids", () => {
  assert.ok(DEFAULT_PAGE_SIZE >= 6 && DEFAULT_PAGE_SIZE <= 24);
});
