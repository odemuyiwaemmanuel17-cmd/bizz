import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatLink,
  buildTelegramUrl,
  buildWhatsAppUrl,
  createChatHref,
  defaultMessage,
  isValidContactHandle,
  parseContactHandle,
} from "../src/lib/contact";

test("parseContactHandle normalizes messy phone numbers", () => {
  const handle = parseContactHandle("whatsapp", "+1 (555) 123-4567");
  assert.notStrictEqual(handle, null);
  assert.strictEqual(handle?.phoneDigits, "15551234567");
});

test("parseContactHandle accepts @handles and t.me URLs", () => {
  assert.strictEqual(parseContactHandle("telegram", "@PixelMark")?.username, "pixelmark");
  assert.strictEqual(parseContactHandle("telegram", "https://t.me/PixelMark")?.username, "pixelmark");
});

test("parseContactHandle rejects junk input", () => {
  assert.strictEqual(parseContactHandle("whatsapp", ""), null);
  assert.strictEqual(parseContactHandle("whatsapp", null), null);
  assert.strictEqual(parseContactHandle("whatsapp", undefined), null);
  assert.strictEqual(parseContactHandle("whatsapp", "12345"), null); // too short
  assert.strictEqual(parseContactHandle("whatsapp", "1".repeat(16)), null); // > E.164
  assert.strictEqual(parseContactHandle("telegram", "@ab"), null); // < 5 chars
  assert.strictEqual(parseContactHandle("telegram", "@bad-name!"), null); // invalid chars
  assert.strictEqual(isValidContactHandle("telegram", "valid_user"), true);
});

test("buildWhatsAppUrl produces a pre-filled wa.me deep link", () => {
  const url = buildWhatsAppUrl("15551234567", "Hi there!");
  // Node's encodeURIComponent leaves `!` unescaped; the URL is valid either way.
  assert.strictEqual(url, "https://wa.me/15551234567?text=Hi%20there!");
  assert.strictEqual(decodeURIComponent(new URL(url as string).searchParams.get("text") ?? ""), "Hi there!");
  assert.strictEqual(buildWhatsAppUrl("123", "x"), null);
});

test("buildTelegramUrl produces a pre-filled t.me deep link", () => {
  const url = buildTelegramUrl("@vizlabstudio", "Is the Thesis Data Viz still available?");
  assert.ok(url !== null && url.startsWith("https://t.me/vizlabstudio?text="));
  assert.ok(decodeURIComponent(url).includes("still available?"));
  assert.strictEqual(buildTelegramUrl("ab", "x"), null);
});

test("defaultMessage embeds the listing title safely", () => {
  assert.ok(defaultMessage("Logo Sprint").includes('"Logo Sprint"'));
  assert.ok(!defaultMessage(null).includes("null"));
  assert.ok(!defaultMessage("").includes('""'));
});

test("createChatHref end-to-end for both channels", () => {
  const wa = createChatHref("whatsapp", "+91 98765 43210", "hello world");
  assert.strictEqual(wa, "https://wa.me/919876543210?text=hello%20world");
  const tg = createChatHref("telegram", "@roomieradar", "yo");
  assert.strictEqual(tg, "https://t.me/roomieradar?text=yo");
  assert.strictEqual(createChatHref("whatsapp", "garbage", "yo"), null);
});

test("buildChatLink returns typed channel results", () => {
  const handle = parseContactHandle("whatsapp", "15551234567");
  assert.notStrictEqual(handle, null);
  const link = buildChatLink(handle as NonNullable<typeof handle>, "ping");
  assert.deepStrictEqual(link, { url: "https://wa.me/15551234567?text=ping", channel: "whatsapp" });
});
