// Test doubles for the GitHub integration tests: an in-memory collection with
// the MongoDB operations the service uses (including unique indexes), and a
// fake fetch that answers like the GitHub REST API.

const get = (doc, key) => doc[key];
const same = (a, b) => String(a) === String(b);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = get(doc, key);
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.some((c) => same(c, value));
      if ("$lt" in cond) return value != null && value < cond.$lt;
    }
    return same(value, cond);
  });
}

function applyUpdate(doc, update, inserting) {
  Object.assign(doc, update.$set || {});
  if (inserting) Object.assign(doc, update.$setOnInsert || {});
  for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
}

export function memoryCollection({ unique = [] } = {}) {
  const docs = [];
  const duplicate = (doc, except) =>
    unique.length && docs.some((d) => d !== except && unique.every((k) => same(d[k], doc[k])));
  // Every call yields once, so concurrent requests interleave like real I/O.
  const tick = () => new Promise((r) => setImmediate(r));
  const copy = (d) => (d ? structuredClone(d) : null);

  return {
    docs,
    async insertOne(doc) {
      await tick();
      if (duplicate(doc)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      docs.push(structuredClone(doc));
      return { acknowledged: true };
    },
    async findOne(filter) {
      await tick();
      return copy(docs.find((d) => matches(d, filter)));
    },
    find(filter) {
      return { toArray: async () => (await tick(), docs.filter((d) => matches(d, filter)).map(copy)) };
    },
    async findOneAndUpdate(filter, update) {
      await tick();
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return null;
      applyUpdate(doc, update, false);
      return copy(doc);
    },
    async updateOne(filter, update, { upsert = false } = {}) {
      await tick();
      const doc = docs.find((d) => matches(d, filter));
      if (doc) {
        applyUpdate(doc, update, false);
        return { matchedCount: 1 };
      }
      if (!upsert) return { matchedCount: 0 };
      const fresh = Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== "object" || v instanceof Date));
      applyUpdate(fresh, update, true);
      docs.push(fresh);
      return { matchedCount: 0, upsertedCount: 1 };
    },
    async deleteOne(filter) {
      await tick();
      const i = docs.findIndex((d) => matches(d, filter));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  };
}

// Routes for a repository's code at one commit: commit lookup, file tree and
// raw file contents (what locate.js reads).
export function repoRoutes(repo, sha, files) {
  const routes = {
    [`GET /repos/${repo}/commits/HEAD`]: () => ({ status: 200, body: { sha } }),
    [`GET /repos/${repo}/git/trees/${sha}`]: () => ({
      status: 200,
      body: { truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })) },
    }),
  };
  for (const [path, text] of Object.entries(files)) routes[`GET /repos/${repo}/contents/${path}`] = () => ({ status: 200, text });
  return routes;
}

// Fake GitHub API. `routes` maps "METHOD /path" (path without query) to a
// function (req) => { status, body | text, headers } or an Error to throw.
export function fakeGithub(routes = {}) {
  const calls = [];
  const issues = [];
  const defaults = {
    "GET /repos/acme/shop": () => ({ status: 200, body: { full_name: "acme/shop", has_issues: true } }),
    "POST /repos/acme/shop/issues": (req) => {
      if (!req.body?.title) return { status: 422, body: { message: "Invalid request. title wasn't supplied." } };
      const issue = { number: issues.length + 1, html_url: `https://github.com/acme/shop/issues/${issues.length + 1}`, ...req.body };
      issues.push(issue);
      return { status: 201, body: issue };
    },
    "GET /repos/acme/shop/issues": () => ({ status: 200, body: issues }),
  };
  async function fetchImpl(url, init) {
    const u = new URL(url);
    const req = { method: init.method, path: decodeURIComponent(u.pathname), query: u.searchParams, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(req);
    await new Promise((r) => setImmediate(r));
    const handler = routes[`${req.method} ${req.path}`] || defaults[`${req.method} ${req.path}`];
    if (!handler) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (handler instanceof Error) throw handler;
    const { status, body, text, headers } = handler(req);
    return new Response(text ?? (body === undefined ? null : JSON.stringify(body)), { status, headers });
  }
  return { fetchImpl, calls, issues, issuePosts: () => calls.filter((c) => c.method === "POST" && c.body?.title) };
}
