import test from "node:test";
import assert from "node:assert/strict";
import { confidenceLabel, createIssue, fetchScreenshotUrl, fetchSource, ticketView } from "./github.js";

const created = { status: "created", repo: "acme/shop", issueNumber: 12, issueUrl: "https://github.com/acme/shop/issues/12" };

test("not connected: offers to connect a repository", () => {
  const v = ticketView({ connected: false, ticket: null });
  assert.equal(v.kind, "connect");
  assert.equal(v.label, "Connect GitHub Repository");
});

test("connected: Create GitHub Issue, then a disabled loading state while creating", () => {
  assert.deepEqual(
    [ticketView({ connected: true, ticket: null }).label, ticketView({ connected: true, ticket: null }).disabled],
    ["Create GitHub Issue", false],
  );
  const busy = ticketView({ connected: true, ticket: null, pending: true });
  assert.deepEqual([busy.kind, busy.label, busy.disabled], ["creating", "Creating issue…", true]);
});

test("success: View Issue link with the issue number, even if disconnected later", () => {
  for (const connected of [true, false]) {
    const v = ticketView({ connected, ticket: created });
    assert.deepEqual([v.kind, v.label, v.href], ["view", "View Issue #12", created.issueUrl]);
  }
});

test("failure: shows the error and lets the user try again", () => {
  const v = ticketView({ connected: true, ticket: null, error: "GitHub rate limit reached." });
  assert.deepEqual([v.kind, v.label, v.message, v.disabled], ["create", "Try again", "GitHub rate limit reached.", false]);
  const failedBefore = ticketView({ connected: true, ticket: { status: "failed" } });
  assert.equal(failedBefore.label, "Try again");
});

test("createIssue posts to the bug's ticket endpoint and surfaces server errors", async () => {
  const calls = [];
  const ok = async (path, init) => (calls.push({ path, init }), new Response(JSON.stringify({ success: true, ...created })));
  const data = await createIssue(ok, { key: "abcdef123456" }, "http://localhost:5000");
  assert.equal(calls[0].path, "/api/bugs/abcdef123456/ticket");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(data.issueNumber, 12);

  const failing = async () => new Response(JSON.stringify({ success: false, error: "Bug not found." }), { status: 404 });
  await assert.rejects(createIssue(failing, { key: "abcdef123456" }), /Bug not found\./);
});

test("source location labels never present a suspicion as certain", () => {
  assert.equal(confidenceLabel({ status: "identified", sourceConfidence: "high" }), "High confidence");
  assert.equal(confidenceLabel({ status: "suspected", sourceConfidence: "low" }), "Suspected (low confidence)");
  assert.equal(confidenceLabel({ status: "unidentified" }), "Not identified");
  assert.equal(confidenceLabel(null), "Not identified");
});

test("dashboard evidence: source and screenshot are fetched with the bug key and tracked URL", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path.includes("/screenshot")) return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    return new Response(JSON.stringify({ success: true, connected: true, location: { status: "suspected", sourceFile: "a.js", sourceLine: 3 } }));
  };
  const bug = { key: "abcdef123456" };
  const source = await fetchSource(api, bug, "http://localhost:5000");
  assert.equal(source.location.sourceFile, "a.js");
  const url = await fetchScreenshotUrl(api, bug, "http://localhost:5000");
  assert.match(url, /^blob:/);
  URL.revokeObjectURL(url);
  assert.deepEqual(paths, [
    "/api/bugs/abcdef123456/source?url=http%3A%2F%2Flocalhost%3A5000",
    "/api/bugs/abcdef123456/screenshot?url=http%3A%2F%2Flocalhost%3A5000",
  ]);
  assert.equal(await fetchScreenshotUrl(async () => new Response("", { status: 404 }), bug), null, "no screenshot is not an error");
});
