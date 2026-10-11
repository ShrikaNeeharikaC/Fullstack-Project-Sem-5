import test from "node:test";
import assert from "node:assert/strict";
import { cacheKey, fingerprintInput, getOrComputeAnalysis } from "./scanCache.js";

const base = {
  userId: "user-1",
  sessionId: "session-hash-1",
  url: "https://example.test/path?b=2&a=1#section",
  config: { viewport: "1440x900", maxPages: 10 },
  unit: "landing",
  input: "page-input",
};

test("cache keys normalize query order and omit URL fragments", () => {
  const key = cacheKey(base);
  assert.equal(key, cacheKey({ ...base, url: "https://example.test/path?a=1&b=2" }));
});

test("cache keys isolate users, auth sessions, URLs, config versions, units and inputs", () => {
  const key = cacheKey(base);
  for (const change of [
    { userId: "user-2" },
    { sessionId: "session-hash-2" },
    { url: "https://example.test/other" },
    { config: { ...base.config, viewport: "1280x720" } },
    { unit: "rank" },
    { input: "changed-page-input" },
  ]) assert.notEqual(cacheKey({ ...base, ...change }), key);
});

test("fingerprints are deterministic and change with relevant input", () => {
  assert.equal(fingerprintInput({ title: "Home", text: ["Sign in"] }), fingerprintInput({ title: "Home", text: ["Sign in"] }));
  assert.notEqual(fingerprintInput({ title: "Home" }), fingerprintInput({ title: "Checkout" }));
});

test("Redis disabled falls back to computation without returning cached data", async () => {
  const before = process.env.SCAN_CACHE_ENABLED;
  const url = process.env.REDIS_URL;
  process.env.SCAN_CACHE_ENABLED = "false";
  delete process.env.REDIS_URL;
  let calls = 0;
  try {
    const result = await getOrComputeAnalysis("test-key", async () => ({ result: ++calls }));
    assert.deepEqual(result, { value: { result: 1 }, hit: false, fallback: true });
    assert.equal(calls, 1);
  } finally {
    if (before === undefined) delete process.env.SCAN_CACHE_ENABLED;
    else process.env.SCAN_CACHE_ENABLED = before;
    if (url !== undefined) process.env.REDIS_URL = url;
  }
});

test("unavailable Redis falls back to the analysis callback", async () => {
  const previousEnabled = process.env.SCAN_CACHE_ENABLED;
  const previousUrl = process.env.REDIS_URL;
  process.env.SCAN_CACHE_ENABLED = "true";
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  let calls = 0;
  try {
    const result = await getOrComputeAnalysis("unavailable-redis", async () => ({ result: ++calls }));
    assert.deepEqual(result, { value: { result: 1 }, hit: false, fallback: true });
    assert.equal(calls, 1);
  } finally {
    if (previousEnabled === undefined) delete process.env.SCAN_CACHE_ENABLED;
    else process.env.SCAN_CACHE_ENABLED = previousEnabled;
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
  }
});
