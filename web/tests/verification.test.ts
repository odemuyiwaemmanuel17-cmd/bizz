import { test } from "vitest";
import assert from "node:assert/strict";
import { validateEvidenceFile } from "../src/lib/verification";

function file(type: string, size: number): File {
  return { type, size } as File;
}

test("verification evidence accepts supported image and document types", () => {
  assert.strictEqual(validateEvidenceFile(file("image/png", 1024)), null);
  assert.strictEqual(validateEvidenceFile(file("application/pdf", 1024)), null);
});

test("verification evidence rejects unsupported or oversized files", () => {
  assert.match(validateEvidenceFile(file("application/zip", 1024)) ?? "", /JPG/);
  assert.match(validateEvidenceFile(file("image/png", 10 * 1024 * 1024 + 1)) ?? "", /10 MB/);
});
