import test from "node:test";
import assert from "node:assert/strict";
import { ciResult, isPublicAddress, launchCiScan, matchesCiApiKey, validatePublicHttpUrl } from "./ciScan.js";
import fs from "node:fs";

test("CI key accepts only an exact bearer key and rejects missing or invalid values", () => {
  assert.equal(matchesCiApiKey("Bearer test-secret", "test-secret"), true);
  assert.equal(matchesCiApiKey(undefined, "test-secret"), false);
  assert.equal(matchesCiApiKey("Bearer wrong", "test-secret"), false);
  assert.equal(matchesCiApiKey("test-secret", "test-secret"), false);
  assert.equal(matchesCiApiKey("Bearer test-secret", ""), false);
});

test("valid CI-authorized launch starts the shared crawler and persists a retrievable run", async () => {
  const inserted = [];
  const updated = [];
  const scanCollection = {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    insertOne: async (doc) => inserted.push(doc),
    updateOne: async (...args) => updated.push(args),
  };
  let resolveRun;
  let options;
  const startScan = (url, opts) => {
    options = opts;
    const scan = { scanId: "scan-test-1", status: "running", done: new Promise((resolve) => { resolveRun = resolve; }) };
    return scan;
  };
  const scan = await launchCiScan({ targetUrl: "https://example.com", startScan, scanCollection });
  assert.equal(scan.scanId, "scan-test-1");
  assert.equal(options.ciMode, true);
  assert.equal(typeof options.askUser, "function");
  assert.equal(await options.askUser(), "skip");
  assert.equal(inserted[0].status, "running");
  scan.status = "done";
  resolveRun({ bugs: [] });
  await scan.done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updated[0][1].$set.status, "done");
  assert.equal(scan.ciSummary.ciStatus, "pass");
});

test("normal session authentication remains mounted for non-CI API requests", () => {
  const server = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api", requireAuth\)/);
  assert.match(server, /app\.post\("\/api\/scan"[\s\S]*?matchesCiApiKey[\s\S]*?return next\(\)/);
});

test("URL validation blocks internal addresses and unsupported schemes", async () => {
  for (const url of ["http://localhost", "http://127.0.0.1", "http://10.0.0.2", "http://169.254.169.254", "http://[::1]", "file:///etc/passwd", "not a url"]) {
    assert.ok(await validatePublicHttpUrl(url), `${url} must be rejected`);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("192.168.1.1"), false);
});

test("baseline fingerprint ignores record ids and known high bugs do not fail CI", () => {
  const known = { title: "Broken checkout", url: "https://shop.example/cart", severity: "high", id: "first-id" };
  const result = ciResult({ runId: "scan-2", status: "done", report: { bugs: [{ ...known, id: "different-id" }] }, baselineReports: [{ bugs: [known] }] });
  assert.equal(result.ciStatus, "pass");
  assert.equal(result.newlyDiscoveredHighSeverityBugs.length, 0);
});

test("new high bugs fail, first runs treat highs as new, and incomplete runs cannot pass", () => {
  const bug = { title: "New payment failure", url: "https://shop.example/pay", severity: "high" };
  const baseline = [{ bugs: [{ title: "Another issue", url: "https://shop.example/", severity: "high" }] }];
  const fresh = ciResult({ runId: "scan-3", status: "done", report: { bugs: [bug] }, baselineReports: baseline });
  assert.equal(fresh.ciStatus, "fail");
  assert.equal(fresh.newlyDiscoveredHighSeverityBugs.length, 1);
  assert.equal(ciResult({ runId: "scan-4", status: "done", report: { bugs: [bug] } }).baselineExists, false);
  assert.equal(ciResult({ runId: "scan-5", status: "running", report: null }).ciStatus, "fail");
  assert.equal(ciResult({ runId: "scan-6", status: "error", report: null }).scanStatus, "failed");
});
