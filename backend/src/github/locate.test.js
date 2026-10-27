import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { githubClient } from "./client.js";
import { normalizeSourcePath, originalPosition, parseStack } from "./sourceMap.js";
import { enclosingFunction, locateSource, matchRepoPath } from "./locate.js";
import { safeScreenshotPath } from "./evidence.js";
import { githubService } from "./service.js";
import { fakeGithub, memoryCollection, repoRoutes } from "./testHelpers.js";

// Source locations and screenshots, with a fake GitHub (repository code,
// screenshot branch) and a fake scanned site (scripts + source maps).

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SITE = "http://shop.test";
const TOKEN = `github_pat_${"A1b2".repeat(12)}`;

// ---------------------------------------------------------------- a small source map

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (values) =>
  values
    .map((v) => {
      let n = v < 0 ? (-v << 1) | 1 : v << 1;
      let out = "";
      do {
        let digit = n & 31;
        n >>>= 5;
        if (n) digit |= 32;
        out += B64[digit];
      } while (n);
      return out;
    })
    .join("");

// Bundle line 1: column 0 → src/main.jsx 1:1; column 16 → src/pages/Login.jsx 42:3 (handleLogin).
// Bundle line 2: column 4 → node_modules/react-dom/index.js 10:1.
const MAP = {
  version: 3,
  sources: ["../../src/main.jsx", "../../src/pages/Login.jsx", "../../node_modules/react-dom/index.js"],
  names: ["handleLogin"],
  mappings: `${vlq([0, 0, 0, 0])},${vlq([16, 1, 41, 2, 0])};${vlq([4, 1, -32, -2])}`,
};

test("source map lookup returns the original file, line and name", () => {
  assert.deepEqual(originalPosition(MAP, 1, 20), { source: "../../src/pages/Login.jsx", line: 42, column: 3, name: "handleLogin" });
  assert.equal(originalPosition(MAP, 1, 5).source, "../../src/main.jsx");
  assert.equal(originalPosition(MAP, 2, 9).source, "../../node_modules/react-dom/index.js");
  assert.equal(originalPosition(MAP, 9, 1), null);
});

test("stack frames, source paths and repository paths are parsed safely", () => {
  assert.deepEqual(parseStack("TypeError: x\n    at handleLogin (http://shop.test/assets/index-1.js:1:20)\n    at http://shop.test/a.js:3:4"), [
    { fn: "handleLogin", url: "http://shop.test/assets/index-1.js", line: 1, column: 20 },
    { fn: null, url: "http://shop.test/a.js", line: 3, column: 4 },
  ]);
  assert.equal(normalizeSourcePath("webpack:///src/x.js"), "src/x.js");
  assert.equal(normalizeSourcePath("webpack://app/./src/x.js"), "src/x.js");
  assert.equal(normalizeSourcePath("../../src/x.js?v=1"), "src/x.js");
  const paths = ["client/src/pages/Login.jsx", "server/index.js", "a/util.js", "b/util.js"];
  assert.equal(matchRepoPath(paths, "../../src/pages/Login.jsx"), "client/src/pages/Login.jsx");
  assert.equal(matchRepoPath(paths, "util.js"), null, "ambiguous matches are not guessed");
  assert.equal(matchRepoPath(paths, "../node_modules/react/index.js"), null);
  assert.equal(enclosingFunction("function Wardrobe() {\n  const x = 1;\n  return <b>Add</b>;\n}", 3), "Wardrobe");
  // An earlier sibling function that already ended doesn't count (real Closet layout).
  const component = "export default function Wardrobe() {\n  async function remove(item) {\n    await api.delete(item);\n  }\n  return (\n    <button>\n      Add item\n    </button>\n  );\n}\n";
  assert.equal(enclosingFunction(component, 7), "Wardrobe");
  assert.equal(enclosingFunction(component, 3), "remove");
});

// ---------------------------------------------------------------- a small repository

const LOGIN = `${"// login page\n".repeat(30)}export default function Login() {\n${"  const a = 1;\n".repeat(10)}  async function handleLogin(e) {\n    throw new Error("boom");\n  }\n}\n`;
const FILES = {
  "client/src/main.jsx": "import App from './App';\n",
  "client/src/pages/Login.jsx": LOGIN,
  "client/src/pages/Wardrobe.jsx":
    "export default function Wardrobe() {\n  function add() {}\n  return (\n    <div>\n      <button onClick={add}>\n        Add item\n      </button>\n    </div>\n  );\n}\n",
  "client/src/api.js": "export const load = () => api.get('/api/items');\n",
  "server/index.js": "const express = require('express');\nconst app = express();\napp.use('/api/items', require('./routes/items'));\napp.listen(5000);\n",
  "server/routes/items.js": "const router = require('express').Router();\n\nrouter.get('/', list);\nrouter.post('/', async (req, res) => {\n  res.json(await create(req.body));\n});\nrouter.delete('/:id', remove);\nmodule.exports = router;\n",
};

function setupRepo(extraRoutes = {}) {
  const gh = fakeGithub({ ...repoRoutes("acme/shop", SHA, FILES), ...extraRoutes });
  return { gh, client: githubClient(TOKEN, { fetchImpl: gh.fetchImpl }) };
}

// The scanned site: a bundle whose source map points into the repository.
function siteFetch({ withMap = true } = {}) {
  return async (url) => {
    if (url === `${SITE}/assets/index-1.js`) return new Response(`bundle();\n//# sourceMappingURL=index-1.js.map\n`);
    if (url === `${SITE}/assets/index-1.js.map` && withMap) return new Response(JSON.stringify(MAP));
    if (url === `${SITE}/src/pages/Login.jsx`) return new Response("export default function Login() {}\n");
    return new Response("not found", { status: 404 });
  };
}

const ev = (over) => ({ pageUrl: `${SITE}/login`, stacks: [], failedRequests: [], elementText: null, ...over });
const opts = (client, fetchImpl = siteFetch()) => ({ client, repo: "acme/shop", sha: SHA, ref: "main", fetchImpl });

test("a stack trace mapped through the source map gives a high-confidence location", async () => {
  const { client } = setupRepo();
  const stack = "    at handleLogin (http://shop.test/assets/index-1.js:1:20)";
  const loc = await locateSource(ev({ stacks: [{ message: "js_exception: boom", stack }] }), opts(client));
  assert.equal(loc.status, "identified");
  assert.equal(loc.sourceConfidence, "high");
  assert.equal(loc.sourceFile, "client/src/pages/Login.jsx");
  assert.equal(loc.sourceLine, 42);
  assert.equal(loc.sourceFunction, "handleLogin");
  assert.equal(loc.sourceCodeUrl, `https://github.com/acme/shop/blob/${SHA}/client/src/pages/Login.jsx#L42`);
  assert.match(loc.sourceReason, /source map/);
});

test("library frames are skipped in favour of the app's own code", async () => {
  const { client } = setupRepo();
  const stack = "    at x (http://shop.test/assets/index-1.js:2:9)\n    at handleLogin (http://shop.test/assets/index-1.js:1:20)";
  const loc = await locateSource(ev({ stacks: [{ message: "err", stack }] }), opts(client));
  assert.equal(loc.sourceFile, "client/src/pages/Login.jsx");
});

test("an unbundled script URL maps to the repository file with medium confidence", async () => {
  const { client } = setupRepo();
  const stack = "    at handleLogin (http://shop.test/src/pages/Login.jsx:42:5)";
  const loc = await locateSource(ev({ stacks: [{ message: "err", stack }] }), opts(client));
  assert.deepEqual([loc.sourceFile, loc.sourceLine, loc.sourceConfidence], ["client/src/pages/Login.jsx", 42, "medium"]);
});

test("third-party stack frames are ignored", async () => {
  const { client } = setupRepo();
  const stack = "    at y (https://cdn.other.test/assets/index-1.js:1:20)";
  const loc = await locateSource(ev({ stacks: [{ message: "err", stack }] }), opts(client));
  assert.equal(loc.status, "unidentified");
});

test("a failing request is correlated with its Express route handler (suspected)", async () => {
  const { client } = setupRepo();
  const loc = await locateSource(ev({ failedRequests: [{ method: "POST", url: `${SITE}/api/items`, status: 500 }] }), opts(client));
  assert.equal(loc.status, "suspected");
  assert.equal(loc.sourceConfidence, "low");
  assert.deepEqual([loc.sourceFile, loc.sourceLine], ["server/routes/items.js", 4]);
  assert.match(loc.sourceReason, /server\/index\.js mounts \/api\/items/);
  assert.match(loc.sourceReason, /not a stack trace/);

  const del = await locateSource(ev({ failedRequests: [{ method: "DELETE", url: `${SITE}/api/items/65ab12`, status: 500 }] }), opts(client));
  assert.deepEqual([del.sourceFile, del.sourceLine], ["server/routes/items.js", 7]);
});

test("a dead button is correlated with where its label is defined (suspected)", async () => {
  const { client } = setupRepo();
  const loc = await locateSource(ev({ elementText: "Add item" }), opts(client));
  assert.deepEqual([loc.status, loc.sourceFile, loc.sourceLine, loc.sourceFunction], ["suspected", "client/src/pages/Wardrobe.jsx", 6, "Wardrobe"]);
});

test("no matching evidence, or unreadable code, is reported as unidentified", async () => {
  const { client } = setupRepo();
  const none = await locateSource(ev({ elementText: "Nothing like this" }), opts(client));
  assert.equal(none.status, "unidentified");
  assert.equal(none.sourceFile, undefined);

  const denied = setupRepo({ [`GET /repos/acme/shop/git/trees/${SHA}`]: () => ({ status: 403, body: { message: "Resource not accessible" } }) });
  const loc = await locateSource(ev({ elementText: "Add item" }), { ...opts(denied.client), sha: "f".repeat(40) });
  assert.equal(loc.status, "unidentified");
});

// ---------------------------------------------------------------- issues with location + screenshot

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const BUG = {
  key: "0123456789ab",
  source: "crawl",
  runId: "scan-9",
  title: "Login throws an error",
  url: `${SITE}/login`,
  severity: "high",
  detected: "2026-10-27T05:00:00.000Z",
  screenshot: "artifacts/scans/scan-9/step-01.png",
  targetUrl: SITE,
};
const REPORT = {
  startUrl: SITE,
  bugs: [
    {
      title: BUG.title,
      severity: "high",
      description: "Logging in throws.",
      url: BUG.url,
      action: 'Click "Log in"',
      screenshot: BUG.screenshot,
      signals: [{ type: "js_exception", message: "boom", stack: "Error: boom\n    at handleLogin (http://shop.test/assets/index-1.js:1:20)", at: BUG.url }],
    },
  ],
  actions: [{ label: 'Click "Log in"', urlBefore: BUG.url, outcome: "error", summary: "An error was thrown.", screenshot: BUG.screenshot }],
};

let tmp;
let cwd;
before(() => {
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = "22".repeat(32);
  process.env.FRONTEND_ORIGIN = "http://localhost:8090";
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bugops-loc-"));
  const dir = path.join(tmp, "artifacts", "scans", "scan-9");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(REPORT));
  fs.writeFileSync(path.join(dir, "step-01.png"), PNG);
  fs.writeFileSync(path.join(tmp, "secret.png"), PNG);
  process.chdir(tmp);
});
after(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Screenshot branch endpoints: the branch doesn't exist yet, then is created.
function uploadRoutes(onPut) {
  return {
    "GET /repos/acme/shop/git/ref/heads/bugops-screenshots": () => ({ status: 404, body: { message: "Not Found" } }),
    "POST /repos/acme/shop/git/trees": () => ({ status: 201, body: { sha: "tree1" } }),
    "POST /repos/acme/shop/git/commits": (req) => (assert.deepEqual(req.body.parents, []), { status: 201, body: { sha: "commit1" } }),
    "POST /repos/acme/shop/git/refs": () => ({ status: 201, body: { ref: "refs/heads/bugops-screenshots" } }),
    "PUT /repos/acme/shop/contents/screenshots/{hash}.png": onPut,
  };
}

async function service(routes, { upload }) {
  const gh = fakeGithub({ ...repoRoutes("acme/shop", SHA, FILES), ...routes });
  // Screenshot paths are content hashes: route any PUT under screenshots/.
  const put = routes["PUT /repos/acme/shop/contents/screenshots/{hash}.png"];
  const fetchImpl = async (url, init) => {
    if (put && init.method === "PUT" && new URL(url).pathname.startsWith("/repos/acme/shop/contents/screenshots/")) {
      gh.calls.push({ method: "PUT", path: new URL(url).pathname, body: JSON.parse(init.body) });
      const { status, body } = put(JSON.parse(init.body));
      return new Response(JSON.stringify(body), { status });
    }
    return gh.fetchImpl(url, init);
  };
  const svc = githubService({
    integrations: () => integrations,
    tickets: () => tickets,
    sources: () => sources,
    findBug: async (userId, key) => (userId === "user-a" && key === BUG.key ? BUG : null),
    makeClient: (token) => githubClient(token, { fetchImpl }),
    siteFetch: siteFetch(),
  });
  const integrations = memoryCollection({ unique: ["userId", "provider"] });
  const tickets = memoryCollection({ unique: ["userId", "bugKey", "repo"] });
  const sources = memoryCollection({ unique: ["userId", "bugKey", "repo", "commit"] });
  await svc.connect("user-a", { repo: "acme/shop", token: TOKEN, uploadScreenshots: upload });
  return { svc, gh, sources };
}

test("the issue links the source line at the scanned commit and embeds the uploaded screenshot", async () => {
  let uploaded = null;
  const { svc, gh } = await service(uploadRoutes((body) => ((uploaded = body), { status: 201, body: {} })), { upload: true });
  const result = await svc.createTicket("user-a", BUG.key);

  assert.equal(result.location.sourceFile, "client/src/pages/Login.jsx");
  assert.equal(result.location.commit, SHA);
  const body = gh.issuePosts()[0].body.body;
  assert.ok(body.includes(`[client/src/pages/Login.jsx#L42](https://github.com/acme/shop/blob/${SHA}/client/src/pages/Login.jsx#L42)`));
  assert.ok(body.includes("**Likely location**: `client/src/pages/Login.jsx`, line 42 (in `handleLogin`)"));
  assert.ok(body.includes("**Confidence:** High"));
  assert.ok(body.includes("at handleLogin (http://shop.test/assets/index-1.js:1:20)"), "stack trace included");
  assert.match(body, /!\[Screenshot of the page when the bug happened\]\(https:\/\/github\.com\/acme\/shop\/blob\/bugops-screenshots\/screenshots\/[0-9a-f]{20}\.png\?raw=true\)/);
  assert.equal(uploaded.branch, "bugops-screenshots");
  assert.equal(Buffer.from(uploaded.content, "base64").toString("hex"), PNG.toString("hex"));
  assert.ok(!body.includes("artifacts/") && !body.includes(tmp), "no local paths in the issue");
});

test("with upload off, or a failed upload, the issue is still created with a BugOps link", async () => {
  const off = await service({}, { upload: false });
  await off.svc.createTicket("user-a", BUG.key);
  const offBody = off.gh.issuePosts()[0].body.body;
  assert.ok(offBody.includes("screenshot upload to the repository is turned off"));
  assert.ok(offBody.includes(`[Open this bug in BugOps](http://localhost:8090/dashboard.html?url=${encodeURIComponent(SITE)})`));
  assert.equal(off.gh.calls.filter((c) => c.method === "PUT").length, 0);

  const denied = await service(
    { "GET /repos/acme/shop/git/ref/heads/bugops-screenshots": () => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }) },
    { upload: true },
  );
  const result = await denied.svc.createTicket("user-a", BUG.key);
  assert.equal(result.status, "created");
  assert.ok(denied.gh.issuePosts()[0].body.body.includes("Contents: Read and write"));
});

test("source locations are cached per commit and only for the bug's owner", async () => {
  const { svc, sources } = await service({}, { upload: false });
  const first = await svc.locate("user-a", BUG.key);
  assert.equal(first.location.sourceFile, "client/src/pages/Login.jsx");
  assert.equal(sources.docs.length, 1);
  assert.equal(sources.docs[0].commit, SHA);
  await svc.locate("user-a", BUG.key);
  assert.equal(sources.docs.length, 1);
  await assert.rejects(svc.locate("user-b", BUG.key), (err) => err.code === "bug_not_found");
});

test("screenshots are served only from the owner's own run records inside artifacts/", async () => {
  const { svc } = await service({}, { upload: false });
  assert.equal(await svc.screenshotPath("user-a", BUG.key), path.resolve("artifacts/scans/scan-9/step-01.png"));
  await assert.rejects(svc.screenshotPath("user-b", BUG.key), (err) => err.code === "bug_not_found");
  await assert.rejects(svc.screenshotPath("user-a", "../../x"), (err) => err.code === "invalid_bug");
  assert.equal(safeScreenshotPath("secret.png"), null, "outside artifacts/");
  assert.equal(safeScreenshotPath("artifacts/../secret.png"), null, "traversal");
  assert.equal(safeScreenshotPath("artifacts/scans/scan-9/report.json"), null, "not a PNG");
  assert.equal(safeScreenshotPath("artifacts/scans/scan-9/missing.png"), null, "missing file");
});
