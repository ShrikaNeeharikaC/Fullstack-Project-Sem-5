import crypto from "crypto";

// Minimal GitHub REST client (Node's built-in fetch). Every failure becomes a
// GitHubError with a code and a message that is safe to show the user: the
// token is only ever placed in the Authorization header, never in messages.

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 15000;
export const SCREENSHOT_BRANCH = "bugops-screenshots";

// owner: GitHub username/org rules; repo: letters, digits, . _ -
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
// Fine-grained (github_pat_...) or classic (ghp_...) tokens.
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;
// Branch, tag or commit SHA (no "..", no leading "-" or "/").
const REF_PATTERN = /^(?!.*\.\.)(?![-/])[A-Za-z0-9._/-]{1,200}$/;

export const isValidRepo = (repo) => typeof repo === "string" && REPO_PATTERN.test(repo);
export const isValidToken = (token) => typeof token === "string" && TOKEN_PATTERN.test(token);
export const isValidRef = (ref) => typeof ref === "string" && REF_PATTERN.test(ref);

export class GitHubError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// What a 403 means depends on what was attempted.
const NEEDS = {
  issues: `"Issues: Read and write"`,
  code: `"Contents: Read"`,
  upload: `"Contents: Read and write"`,
};
const ATTEMPT = { issues: "create issues in", code: "read the code of", upload: "upload screenshots to" };

// Turns a non-2xx response into a GitHubError the user can act on.
function errorFor(res, body, repo, purpose) {
  const ghMessage = typeof body?.message === "string" ? body.message : "";
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(ghMessage)))) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(res.headers.get("retry-after"));
    const when = retryAfter
      ? `in ${retryAfter} seconds`
      : reset
        ? `after ${new Date(reset * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
        : "later";
    return new GitHubError("rate_limited", `GitHub rate limit reached. Try again ${when}.`, res.status);
  }
  if (res.status === 401) {
    return new GitHubError("invalid_token", "GitHub rejected the token. It may be wrong, expired or revoked: generate a new one.", 401);
  }
  if (res.status === 403) {
    return new GitHubError(
      "no_permission",
      `The token can't ${ATTEMPT[purpose]} ${repo}. Give it ${NEEDS[purpose]} permission for this repository.`,
      403,
    );
  }
  if (res.status === 404) {
    return new GitHubError(
      "not_found",
      purpose === "issues"
        ? `Repository ${repo} was not found, or the token has no access to it. Check the name and the token's repository access.`
        : `Not found in ${repo} (or the token can't read it).`,
      404,
    );
  }
  if (res.status === 409 && purpose !== "issues") return new GitHubError("empty_repo", `${repo} has no commits yet.`, 409);
  if (res.status === 410) return new GitHubError("issues_disabled", `Issues are turned off for ${repo}.`, 410);
  if (res.status === 422) return new GitHubError("validation", `GitHub rejected the request: ${ghMessage || "invalid data"}`.slice(0, 300), 422);
  if (res.status >= 500) return new GitHubError("github_down", "GitHub is having problems right now. Try again in a few minutes.", res.status);
  return new GitHubError("github_error", `GitHub request failed (HTTP ${res.status}).`, res.status);
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

export function githubClient(token, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  // purpose: "issues" | "code" | "upload" (for permission messages); raw: return text.
  async function request(method, path, body, repo, { purpose = "issues", raw = false } = {}) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "BugOps",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new GitHubError("timeout", "GitHub did not answer in time. Try again.");
      }
      throw new GitHubError("network", "Could not reach GitHub. Check the server's internet connection.");
    }
    const text = await res.text();
    if (raw && res.ok) return text;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw Object.assign(errorFor(res, json, repo, purpose), { details: json });
    return json;
  }

  // The screenshots branch holds only screenshots: an orphan branch (no
  // shared history with the code), created on first use.
  async function ensureScreenshotBranch(repo) {
    try {
      await request("GET", `/repos/${repo}/git/ref/heads/${SCREENSHOT_BRANCH}`, null, repo, { purpose: "upload" });
      return;
    } catch (err) {
      if (err.code !== "not_found") throw err;
    }
    const opts = { purpose: "upload" };
    const tree = await request(
      "POST",
      `/repos/${repo}/git/trees`,
      { tree: [{ path: "README.md", mode: "100644", type: "blob", content: "Screenshots embedded in BugOps issues. This branch has no code.\n" }] },
      repo,
      opts,
    );
    const commit = await request("POST", `/repos/${repo}/git/commits`, { message: "BugOps screenshots", tree: tree.sha, parents: [] }, repo, opts);
    try {
      await request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${SCREENSHOT_BRANCH}`, sha: commit.sha }, repo, opts);
    } catch (err) {
      if (err.code !== "validation") throw err; // created meanwhile by another request
    }
  }

  return {
    getRepo: (repo) => request("GET", `/repos/${repo}`, null, repo),

    // Can this token create issues here? Posting an issue with no title is
    // rejected with 422 when the token may create issues, and 403 when it
    // may not, so nothing is created either way.
    async checkIssueAccess(repo) {
      try {
        await request("POST", `/repos/${repo}/issues`, {}, repo);
      } catch (err) {
        if (err.code === "validation") return;
        throw err;
      }
      throw new GitHubError("github_error", "Unexpected answer from GitHub while checking permissions.");
    },

    // Labels GitHub can't apply (e.g. no permission to create them) are
    // retried without, instead of failing the whole issue.
    async createIssue(repo, { title, body, labels = [] }) {
      try {
        return await request("POST", `/repos/${repo}/issues`, { title, body, labels }, repo);
      } catch (err) {
        if (labels.length && err.code === "validation" && /label/i.test(JSON.stringify(err.details || ""))) {
          return request("POST", `/repos/${repo}/issues`, { title, body }, repo);
        }
        throw err;
      }
    },

    // An issue BugOps created earlier for this bug, found by the hidden marker
    // in its body (recovers from a crash between creating and saving it).
    async findIssueByMarker(repo, marker, since) {
      const query = new URLSearchParams({ state: "all", sort: "created", direction: "desc", per_page: "100" });
      if (since) query.set("since", new Date(since).toISOString());
      const issues = await request("GET", `/repos/${repo}/issues?${query}`, null, repo);
      return (issues || []).find((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(marker)) || null;
    },

    // Full commit SHA for a branch, tag or SHA, so links point at fixed code.
    async resolveCommit(repo, ref) {
      const commit = await request("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}`, null, repo, { purpose: "code" });
      return commit.sha;
    },

    // Every file path in the repository at a commit (with sizes).
    async listFiles(repo, sha) {
      const tree = await request("GET", `/repos/${repo}/git/trees/${sha}?recursive=1`, null, repo, { purpose: "code" });
      return {
        files: (tree.tree || []).filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0 })),
        truncated: !!tree.truncated,
      };
    },

    readFile: (repo, path, sha) =>
      request("GET", `/repos/${repo}/contents/${encodePath(path)}?ref=${sha}`, null, repo, { purpose: "code", raw: true }),

    // Stores a PNG on the screenshots branch under its content hash (the same
    // screenshot is only stored once) and returns a URL GitHub renders in
    // issues for everyone who can see the repository.
    async uploadScreenshot(repo, png) {
      await ensureScreenshotBranch(repo);
      const path = `screenshots/${crypto.createHash("sha256").update(png).digest("hex").slice(0, 20)}.png`;
      try {
        await request(
          "PUT",
          `/repos/${repo}/contents/${path}`,
          { message: `BugOps screenshot ${path}`, content: png.toString("base64"), branch: SCREENSHOT_BRANCH },
          repo,
          { purpose: "upload" },
        );
      } catch (err) {
        if (err.code !== "validation") throw err; // already uploaded (same content, same path)
      }
      return `https://github.com/${repo}/blob/${SCREENSHOT_BRANCH}/${path}?raw=true`;
    },
  };
}
