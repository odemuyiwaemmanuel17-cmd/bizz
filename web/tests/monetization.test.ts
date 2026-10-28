import { test } from "vitest";
import assert from "node:assert/strict";
import { formatMinorAmount } from "../src/lib/monetization";

test("formatMinorAmount preserves the supplied transaction currency", () => {
  assert.equal(formatMinorAmount(1250, "USD"), "$12.50");
  assert.match(formatMinorAmount(150000, "NGN"), /(?:NGN|₦).*1,500\.00/);
});
