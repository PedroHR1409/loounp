import assert from "node:assert/strict";
import { test } from "vitest";

import { validateFeedUrl } from "./feed-url";

test("accepts any public HTTPS host, not only medium.com", () => {
  assert.equal(
    validateFeedUrl("https://example.com/feed.xml"),
    "https://example.com/feed.xml",
  );
  assert.equal(
    validateFeedUrl("https://medium.com/feed/tag/ai"),
    "https://medium.com/feed/tag/ai",
  );
});

test("rejects non-HTTPS and malformed URLs", () => {
  assert.throws(() => validateFeedUrl("http://example.com/feed.xml"), /HTTPS/);
  assert.throws(() => validateFeedUrl("not a url"), /inválida/);
  assert.throws(() => validateFeedUrl(42), /texto/);
});

test("rejects private, loopback, and link-local hosts", () => {
  const blocked = [
    "https://localhost/feed.xml",
    "https://127.0.0.1/feed.xml",
    "https://10.0.0.5/feed.xml",
    "https://172.16.0.5/feed.xml",
    "https://192.168.1.5/feed.xml",
    "https://169.254.169.254/latest/meta-data",
    "https://[::]/feed.xml",
    "https://[::1]/feed.xml",
    "https://[fc00::1]/feed.xml",
    "https://[fd12:3456::1]/feed.xml",
    "https://[fe80::1]/feed.xml",
    "https://[::ffff:127.0.0.1]/feed.xml",
    "https://[::ffff:10.0.0.5]/feed.xml",
  ];
  for (const url of blocked) {
    assert.throws(
      () => validateFeedUrl(url),
      /rede privada\/local/,
      `expected ${url} to be rejected`,
    );
  }
  assert.equal(
    validateFeedUrl("https://[2606:4700:4700::1111]/feed.xml"),
    "https://[2606:4700:4700::1111]/feed.xml",
  );
});

test("strips the URL fragment", () => {
  assert.equal(
    validateFeedUrl("https://example.com/feed.xml#section"),
    "https://example.com/feed.xml",
  );
});
