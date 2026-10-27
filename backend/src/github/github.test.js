import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import { githubClient } from "./client.js";
import { decryptSecret, encryptSecret, SecretsConfigError } from "./secrets.js";
import { buildIssue, issueMarker } from "./issueBody.js";
import { gatherEvidence, hasEnoughDetail } from "./evidence.js";
import { githubService, STALE_MS } from "./service.js";
import { githubRouter } from "./routes.js";
import { fakeGithub, memoryCollection } from "./testHelpers.js";

// No real GitHub token or database: GitHub is a fake fetch and MongoDB is an
// in-memory collection with the same unique indexes.

const KEY = "11".repeat(32);
const TOKEN = `github_pat_${"A1b2".repeat(12)}`;
const USER_A = "user-a";
const USER_B = "user-b";

// A crawler bug as the dashboard row shows it, with its run's artifacts.
const BUG = {
  key: "abcdef123456",
  source: "crawl",
  runId: "scan-1",
  title: "Add item button is non-functional",
  url: "http://localhost:5000/wardrobe",
  page: "/wardrobe",
  severity: "high",
  detected: "2026-10-27T05:00:00.000Z",
  screenshot: "artifacts/scans/scan-1/step-03.png",
  fix: "Wire up the click handler.",
};
const REPORT = {
  scanId: "scan-1",
  startUrl: "http://localhost:5000",
  bugs: [
    {
      title: BUG.title,
      severity: "high",
      description: "Clicking 'Add item' does nothing; ping @octocat",
      rca: "The click handler is missing.",
      suggested_fix: "Wire up the click handler.",
      url: BUG.url,
      action: 'Click "Add item"',
      screenshot: BUG.screenshot,
      signals: [{ type: "js_exception", message: "TypeError: x is undefined", at: BUG.url }],
    },
  ],
  actions: [
    {
      label: 'Click "Add item"',
      urlBefore: BUG.url,
      expected: "A form for a new item opens.",
      outcome: "no_effect",
      summary: "Nothing changed on the screen.",
      screenshot: BUG.screenshot,
    },
  ],
};

let tmp;
let cwd;
before(() => {
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = KEY;
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bugops-gh-"));
  fs.mkdirSync(path.join(tmp, "artifacts", "scans", "scan-1"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "artifacts", "scans", "scan-1", "report.json"), JSON.stringify(REPORT));
  process.chdir(tmp);
});
after(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Only user A owns BUG, like findUserBug (which searches the caller's scans).
const findBug = async (userId, key) => (userId === USER_A && key === BUG.key ? BUG : null);

function setup(routes, extra = {}) {
  const gh = fakeGithub(routes);
  const integrations = memoryCollection({ unique: ["userId", "provider"] });
  const tickets = memoryCollection({ unique: ["userId", "bugKey", "repo"] });
  const service = githubService({
    integrations: () => integrations,
    tickets: () => tickets,
    findBug,
    makeClient: (token) => githubClient(token, { fetchImpl: gh.fetchImpl }),
    ...extra,
  });
  return { gh, integrations, tickets, service };
}

// Connected as user A. An overridden "create issue" route only answers real
// issues; the permission probe made while connecting (no title) gets the usual 422.
async function connected(routes = {}) {
  const post = routes["POST /repos/acme/shop/issues"];
  if (post) {
    routes = {
      ...routes,
      "POST /repos/acme/shop/issues": (req) => {
        if (!req.body?.title) return { status: 422, body: { message: "Invalid request. title wasn't supplied." } };
        if (post instanceof Error) throw post;
        return post(req);
      },
    };
  }
  const ctx = setup(routes);
  await ctx.service.connect(USER_A, { repo: "acme/shop", token: TOKEN });
  ctx.gh.calls.length = 0;
  return ctx;
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err.code === code);

// ---------------------------------------------------------------- secrets

test("tokens round-trip through AES-256-GCM and are bound to their owner", () => {
  const box = encryptSecret(TOKEN, USER_A);
  assert.ok(!JSON.stringify(box).includes(TOKEN));
  assert.equal(decryptSecret(box, USER_A), TOKEN);
  assert.throws(() => decryptSecret(box, USER_B));
  assert.throws(() => decryptSecret({ ...box, data: Buffer.from("tampered").toString("base64") }, USER_A));
});

test("a missing encryption key is a configuration error", () => {
  const saved = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptSecret(TOKEN, USER_A), SecretsConfigError);
  } finally {
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = saved;
  }
});

// ---------------------------------------------------------------- connecting

test("connecting checks the repo and permission, then stores the token encrypted", async () => {
  const { service, integrations, gh } = setup();
  const conn = await service.connect(USER_A, { repo: "acme/shop", token: TOKEN });
  assert.deepEqual([conn.connected, conn.repo], [true, "acme/shop"]);
  assert.ok(!JSON.stringify(conn).includes(TOKEN), "token never returned");
  assert.ok(!JSON.stringify(integrations.docs).includes(TOKEN), "token never stored in plain text");
  // The permission probe posts an issue with no title, which GitHub rejects: nothing is created.
  assert.equal(gh.issues.length, 0);
  const probe = gh.calls.find((c) => c.method === "POST");
  assert.equal(probe.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(probe.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(probe.headers.Accept, "application/vnd.github+json");
});

test("connecting rejects bad repository names and tokens before calling GitHub", async () => {
  const { service, gh } = setup();
  await rejectsWith(service.connect(USER_A, { repo: "not a repo", token: TOKEN }), "invalid_repo");
  await rejectsWith(service.connect(USER_A, { repo: "acme/../x", token: TOKEN }), "invalid_repo");
  await rejectsWith(service.connect(USER_A, { repo: "acme/shop", token: "short" }), "invalid_token");
  assert.equal(gh.calls.length, 0);
});

test("invalid tokens and missing permissions are reported clearly", async () => {
  const badToken = setup({ "GET /repos/acme/shop": () => ({ status: 401, body: { message: "Bad credentials" } }) });
  await rejectsWith(badToken.service.connect(USER_A, { repo: "acme/shop", token: TOKEN }), "invalid_token");

  const readOnly = setup({
    "POST /repos/acme/shop/issues": () => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }),
  });
  await rejectsWith(readOnly.service.connect(USER_A, { repo: "acme/shop", token: TOKEN }), "no_permission");

  const noAccess = setup({ "GET /repos/acme/shop": () => ({ status: 404, body: { message: "Not Found" } }) });
  await rejectsWith(noAccess.service.connect(USER_A, { repo: "acme/shop", token: TOKEN }), "not_found");

  for (const ctx of [badToken, readOnly, noAccess]) assert.equal(ctx.integrations.docs.length, 0, "nothing saved on failure");
});

test("updating the repository keeps the saved token; disconnect removes it", async () => {
  const { service, integrations } = setup({
    "GET /repos/acme/web": () => ({ status: 200, body: { full_name: "acme/web", has_issues: true } }),
    "POST /repos/acme/web/issues": () => ({ status: 422, body: { message: "title wasn't supplied" } }),
  });
  await service.connect(USER_A, { repo: "acme/shop", token: TOKEN });
  const updated = await service.connect(USER_A, { repo: "acme/web" });
  assert.equal(updated.repo, "acme/web");
  assert.equal(decryptSecret(integrations.docs[0].token, USER_A), TOKEN);
  await service.disconnect(USER_A);
  assert.deepEqual(await service.getConnection(USER_A), { connected: false });
});

// ---------------------------------------------------------------- creating issues

test("a valid bug creates an issue with its details", async () => {
  const { service, gh, tickets } = await connected();
  const result = await service.createTicket(USER_A, BUG.key, { url: BUG.url });

  assert.deepEqual(
    { status: result.status, repo: result.repo, issueNumber: result.issueNumber, issueUrl: result.issueUrl, reused: result.reused },
    { status: "created", repo: "acme/shop", issueNumber: 1, issueUrl: "https://github.com/acme/shop/issues/1", reused: false },
  );
  // This fake repository's code isn't readable, so the location is unidentified (and doesn't block the issue).
  assert.equal(result.location.status, "unidentified");
  const [post] = gh.issuePosts();
  assert.equal(post.body.title, "[BugOps][HIGH] Add item button is non-functional");
  assert.deepEqual(post.body.labels, ["bugops", "severity:high"]);
  const body = post.body.body;
  for (const expected of [
    "## Summary",
    "| **Severity** | High |",
    BUG.url,
    "## Error message and stack trace (confirmed)",
    "js_exception: TypeError: x is undefined",
    "## Steps to reproduce",
    "1. Open http://localhost:5000.",
    '3. Click "Add item".',
    "A form for a new item opens.",
    "Nothing changed on the screen.",
    "**Suspected (AI analysis, not verified):** The click handler is missing.",
    "Wire up the click handler.",
    "`step-03.png`",
    "## Likely source-code location\n\n**Not identified.**",
    "## Suggested fix (not a confirmed finding)",
    issueMarker(USER_A, BUG.key),
  ]) assert.ok(body.includes(expected), `issue body contains ${JSON.stringify(expected)}`);
  assert.ok(!body.includes("@octocat"), "mentions from scanned content are neutralized");
  assert.ok(!body.includes(tmp) && !body.includes("artifacts/scans"), "no local file paths");
  assert.equal(tickets.docs[0].status, "created");
  assert.equal(tickets.docs[0].issueNumber, 1);
});

test("repeated and concurrent requests never create a second issue", async () => {
  const { service, gh } = await connected();
  const results = await Promise.allSettled([
    service.createTicket(USER_A, BUG.key),
    service.createTicket(USER_A, BUG.key),
    service.createTicket(USER_A, BUG.key),
  ]);
  assert.equal(gh.issuePosts().length, 1);
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  assert.ok(ok.some((r) => r.reused === false));
  for (const r of results.filter((r) => r.status === "rejected")) assert.equal(r.reason.code, "in_progress");

  const again = await service.createTicket(USER_A, BUG.key);
  assert.deepEqual([again.reused, again.issueNumber], [true, 1]);
  assert.equal(gh.issuePosts().length, 1);
});

test("a user can't use another user's bug, and needs their own connection", async () => {
  const { service, gh } = await connected();
  await rejectsWith(service.createTicket(USER_B, BUG.key), "not_connected");
  await service.connect(USER_B, { repo: "acme/shop", token: TOKEN });
  await rejectsWith(service.createTicket(USER_B, BUG.key), "bug_not_found");
  assert.equal(gh.issuePosts().length, 0);
  assert.deepEqual(await service.ticketsFor(USER_B, [BUG.key]), {});
});

test("bad bug ids are rejected before any lookup", async () => {
  const { service } = await connected();
  await rejectsWith(service.createTicket(USER_A, "../../etc"), "invalid_bug");
  await rejectsWith(service.createTicket(USER_A, "ABCDEF123456"), "invalid_bug");
});

test("GitHub failures are reported, recorded as failed, and can be retried", async () => {
  let down = true;
  const ctx = await connected({
    "POST /repos/acme/shop/issues": (req) =>
      down ? { status: 502, body: { message: "Server Error" } } : { status: 201, body: { number: 7, html_url: "https://github.com/acme/shop/issues/7", ...req.body } },
  });
  await rejectsWith(ctx.service.createTicket(USER_A, BUG.key), "github_down");
  assert.equal(ctx.tickets.docs[0].status, "failed");

  down = false;
  const retry = await ctx.service.createTicket(USER_A, BUG.key);
  assert.deepEqual([retry.status, retry.issueNumber], ["created", 7]);
});

test("rate limits, revoked tokens and network errors map to clear errors", async () => {
  const limited = await connected({
    "POST /repos/acme/shop/issues": () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }, body: { message: "API rate limit exceeded" } }),
  });
  await rejectsWith(limited.service.createTicket(USER_A, BUG.key), "rate_limited");

  const revoked = await connected({ "POST /repos/acme/shop/issues": () => ({ status: 401, body: { message: "Bad credentials" } }) });
  await rejectsWith(revoked.service.createTicket(USER_A, BUG.key), "invalid_token");

  const offline = await connected({ "POST /repos/acme/shop/issues": new TypeError("fetch failed") });
  await rejectsWith(offline.service.createTicket(USER_A, BUG.key), "network");
});

test("unknown labels don't stop the issue from being created", async () => {
  const { service, gh } = await connected({
    "POST /repos/acme/shop/issues": (req) =>
      req.body.labels
        ? { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Label", code: "invalid" }] } }
        : { status: 201, body: { number: 3, html_url: "https://github.com/acme/shop/issues/3", ...req.body } },
  });
  const result = await service.createTicket(USER_A, BUG.key);
  assert.equal(result.issueNumber, 3);
  assert.equal(gh.issuePosts().length, 2);
});

test("an issue created before a crash is found by its marker instead of duplicated", async () => {
  let clock = new Date("2026-10-27T10:00:00Z");
  const gh = fakeGithub();
  const integrations = memoryCollection({ unique: ["userId", "provider"] });
  const tickets = memoryCollection({ unique: ["userId", "bugKey", "repo"] });
  const service = githubService({
    integrations: () => integrations,
    tickets: () => tickets,
    findBug,
    makeClient: (token) => githubClient(token, { fetchImpl: gh.fetchImpl }),
    now: () => clock,
  });
  await service.connect(USER_A, { repo: "acme/shop", token: TOKEN });

  // The issue exists on GitHub, but the ticket was left "creating" (crash).
  gh.issues.push({ number: 9, html_url: "https://github.com/acme/shop/issues/9", body: `...\n${issueMarker(USER_A, BUG.key)}\n` });
  await tickets.insertOne({ userId: USER_A, bugKey: BUG.key, repo: "acme/shop", status: "creating", claimId: "old", claimedAt: clock, createdAt: clock });

  await rejectsWith(service.createTicket(USER_A, BUG.key), "in_progress"); // too recent to take over
  clock = new Date(clock.getTime() + STALE_MS + 1000);
  const result = await service.createTicket(USER_A, BUG.key);
  assert.deepEqual([result.issueNumber, result.reused], [9, true]);
  assert.equal(gh.issuePosts().length, 0);
  assert.equal(tickets.docs[0].status, "created");
});

// ---------------------------------------------------------------- issue content

test("the issue never invents a root cause or source location", () => {
  const ev = { ...gatherEvidence({ ...BUG, runId: "scan-missing" }) };
  assert.equal(ev.rootCause, null);
  const { body } = buildIssue(ev, { marker: "<!-- m -->" });
  assert.ok(body.includes("**Unknown.**"));
  assert.ok(body.includes("**Not identified.**"));
  assert.ok(!body.includes("## Expected behavior"), "no expected behaviour when none was recorded");
});

test("bugs without recorded detail are refused", () => {
  assert.equal(hasEnoughDetail({ title: "x", pageUrl: "http://a", steps: [], errors: [], failedChecks: [], actual: [], summaryBasis: null }), false);
  assert.equal(hasEnoughDetail(gatherEvidence(BUG)), true);
});

// ---------------------------------------------------------------- HTTP routes

test("routes return safe errors and never echo the token", async () => {
  const ctx = setup({ "GET /repos/acme/shop": () => ({ status: 401, body: { message: "Bad credentials" } }) });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => ((req.user = { _id: USER_A }), next()));
  app.use("/api", githubRouter(ctx.service));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const put = await fetch(`${base}/integrations/github`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "acme/shop", token: TOKEN }) });
    const putText = await put.text();
    assert.equal(put.status, 400);
    assert.ok(!putText.includes(TOKEN));
    assert.equal(JSON.parse(putText).code, "invalid_token");

    const ticket = await fetch(`${base}/bugs/${BUG.key}/ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(ticket.status, 409);
    assert.equal((await ticket.json()).code, "not_connected");

    const conn = await (await fetch(`${base}/integrations/github`)).json();
    assert.deepEqual(conn, { success: true, connected: false });
  } finally {
    server.close();
  }
});
