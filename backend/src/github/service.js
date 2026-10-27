import fs from "fs";
import { githubClient, GitHubError, isValidRef, isValidRepo, isValidToken } from "./client.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { gatherEvidence, hasEnoughDetail } from "./evidence.js";
import { buildIssue, issueMarker } from "./issueBody.js";
import { locateSource } from "./locate.js";

// GitHub integration: one connected repository per user, and at most one
// issue per user + bug + repository.
//
// Duplicates are prevented in MongoDB, not memory: creating an issue first
// inserts a "creating" ticket, and the unique index on (userId, bugKey, repo)
// lets only one request win. Others get the existing issue, or "in progress".
// A "creating" ticket older than STALE_MS (a crash between GitHub creating the
// issue and the database saving it) may be taken over; before creating again,
// the repository is searched for the issue's hidden marker and that is reused.
//
// Source locations are computed from the repository at a fixed commit (the
// configured deployed ref, else the default branch's latest commit) and cached
// per user + bug + repository + commit.

export const STALE_MS = 2 * 60 * 1000;
const PROVIDER = "github";
const BUG_KEY = /^[a-f0-9]{12}$/;

export class ServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const publicConnection = (doc) =>
  doc
    ? {
        connected: true,
        repo: doc.repo,
        ref: doc.ref || null,
        defaultBranch: doc.defaultBranch || null,
        repoPrivate: doc.repoPrivate ?? null,
        uploadScreenshots: !!doc.uploadScreenshots,
        connectedAt: doc.connectedAt,
        updatedAt: doc.updatedAt,
      }
    : { connected: false };
const publicTicket = (t) => ({ status: t.status, repo: t.repo, issueNumber: t.issueNumber ?? null, issueUrl: t.issueUrl ?? null });
// Only real GitHub issue pages are ever handed to the browser to open.
const safeIssueUrl = (url, repo) => (typeof url === "string" && url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/issues/`) ? url : null);
// The location fields the dashboard and API expose.
const publicLocation = (l) =>
  l && {
    status: l.status,
    sourceFile: l.sourceFile ?? null,
    sourceLine: l.sourceLine ?? null,
    sourceFunction: l.sourceFunction ?? null,
    sourceCodeUrl: l.sourceCodeUrl ?? null,
    sourceConfidence: l.sourceConfidence ?? null,
    sourceReason: l.sourceReason ?? null,
    commit: l.commit ?? null,
    ref: l.ref ?? null,
  };

// Link to the bug's target on the BugOps dashboard (needs a login to open).
function dashboardLink(bug) {
  const origin = process.env.FRONTEND_ORIGIN;
  if (!origin || !/^https?:\/\//.test(origin) || !bug.targetUrl) return null;
  return `${origin.replace(/\/$/, "")}/dashboard.html?url=${encodeURIComponent(bug.targetUrl)}`;
}

export function githubService({
  integrations,
  tickets,
  sources = null,
  findBug,
  evidenceFor = gatherEvidence,
  makeClient = githubClient,
  siteFetch = globalThis.fetch,
  now = () => new Date(),
}) {
  async function connection(userId) {
    return integrations().findOne({ userId, provider: PROVIDER });
  }

  function tokenOf(doc, userId) {
    try {
      return decryptSecret(doc.token, String(userId));
    } catch {
      throw new ServiceError("reconnect", "The saved GitHub token can't be read anymore. Connect the repository again.", 409);
    }
  }

  async function ownedBug(userId, key, url) {
    if (!BUG_KEY.test(String(key))) throw new ServiceError("invalid_bug", "Invalid bug id.", 400);
    const bug = await findBug(userId, key, typeof url === "string" ? url.slice(0, 2048) : undefined);
    if (!bug) throw new ServiceError("bug_not_found", "Bug not found.", 404);
    return bug;
  }

  // The source location for a bug at the commit currently configured. Never
  // throws for GitHub/code problems: those become an "unidentified" result.
  async function locationFor(userId, conn, github, key, evidence) {
    const ref = conn.ref || conn.defaultBranch;
    let sha;
    try {
      sha = await github.resolveCommit(conn.repo, ref || "HEAD");
    } catch (err) {
      return { status: "unidentified", sourceReason: `The repository's code couldn't be read: ${err.message}`, commit: null, ref };
    }
    const cacheKey = { userId, bugKey: key, repo: conn.repo, commit: sha };
    const cached = sources ? await sources().findOne(cacheKey) : null;
    if (cached?.location) return cached.location;
    const location = await locateSource(evidence, { client: github, repo: conn.repo, sha, ref, fetchImpl: siteFetch });
    if (sources) {
      await sources()
        .updateOne(cacheKey, { $set: { location, computedAt: now() } }, { upsert: true })
        .catch(() => {});
    }
    return location;
  }

  // Uploads the screenshot when the user turned that on; otherwise (or on
  // failure) says why, with a link to see it in BugOps.
  async function screenshotFor(conn, github, evidence, bug) {
    const dashboardUrl = dashboardLink(bug);
    if (!evidence.screenshotPath) return { note: "the screenshot file is no longer available", dashboardUrl };
    if (!conn.uploadScreenshots) return { note: "screenshot upload to the repository is turned off in BugOps settings", dashboardUrl };
    try {
      return { imageUrl: await github.uploadScreenshot(conn.repo, fs.readFileSync(evidence.screenshotPath)) };
    } catch (err) {
      return { note: `the upload to GitHub failed (${err instanceof GitHubError ? err.message : "unexpected error"})`, dashboardUrl };
    }
  }

  return {
    async getConnection(userId) {
      return publicConnection(await connection(userId));
    },

    // Checks the repository and the token's permission, then saves both. A
    // missing token keeps the saved one (changing only the settings).
    async connect(userId, { repo, token, ref, uploadScreenshots }) {
      repo = typeof repo === "string" ? repo.trim() : "";
      token = typeof token === "string" ? token.trim() : "";
      ref = typeof ref === "string" ? ref.trim() : "";
      if (!isValidRepo(repo)) throw new ServiceError("invalid_repo", "Enter the repository as owner/repo, e.g. octocat/hello-world.", 400);
      if (ref && !isValidRef(ref)) throw new ServiceError("invalid_ref", "Enter a branch name, tag or commit SHA (or leave it empty).", 400);
      const existing = await connection(userId);
      if (!token) {
        if (!existing) throw new ServiceError("invalid_token", "Paste a GitHub personal access token.", 400);
        token = tokenOf(existing, userId);
      } else if (!isValidToken(token)) {
        throw new ServiceError("invalid_token", "That doesn't look like a GitHub token (it should start with github_pat_ or ghp_).", 400);
      }

      const github = makeClient(token);
      const info = await github.getRepo(repo);
      const fullName = isValidRepo(info?.full_name) ? info.full_name : repo;
      if (info?.has_issues === false) throw new GitHubError("issues_disabled", `Issues are turned off for ${fullName}.`, 410);
      await github.checkIssueAccess(fullName);
      if (ref) {
        try {
          await github.resolveCommit(fullName, ref);
        } catch (err) {
          if (err.code === "not_found" || err.code === "validation") {
            throw new ServiceError("invalid_ref", `Branch, tag or commit "${ref}" was not found in ${fullName}.`, 400);
          }
          throw err;
        }
      }

      const at = now();
      await integrations().updateOne(
        { userId, provider: PROVIDER },
        {
          $set: {
            repo: fullName,
            token: encryptSecret(token, String(userId)),
            ref: ref || null,
            defaultBranch: typeof info?.default_branch === "string" ? info.default_branch : null,
            repoPrivate: typeof info?.private === "boolean" ? info.private : null,
            uploadScreenshots: uploadScreenshots === true,
            updatedAt: at,
          },
          $setOnInsert: { connectedAt: at },
        },
        { upsert: true },
      );
      return publicConnection(await connection(userId));
    },

    async disconnect(userId) {
      await integrations().deleteOne({ userId, provider: PROVIDER });
      return { connected: false };
    },

    // Ticket state for the dashboard rows, for the connected repository.
    async ticketsFor(userId, keys) {
      const conn = await connection(userId);
      if (!conn || !keys.length) return {};
      const list = await tickets().find({ userId, repo: conn.repo, bugKey: { $in: keys } }).toArray();
      return Object.fromEntries(list.map((t) => [t.bugKey, publicTicket(t)]));
    },

    // Likely source location of one of the user's bugs (dashboard).
    async locate(userId, key, { url } = {}) {
      const bug = await ownedBug(userId, key, url);
      const conn = await connection(userId);
      if (!conn) return { location: null, connected: false };
      const github = makeClient(tokenOf(conn, userId));
      return { connected: true, location: publicLocation(await locationFor(userId, conn, github, key, evidenceFor(bug))) };
    },

    // Absolute path of one of the user's bug screenshots, or null. The path
    // comes from the bug's own run records and is checked to be in artifacts/.
    async screenshotPath(userId, key, { url } = {}) {
      const bug = await ownedBug(userId, key, url);
      return evidenceFor(bug).screenshotPath || null;
    },

    async createTicket(userId, key, { url } = {}) {
      if (!BUG_KEY.test(String(key))) throw new ServiceError("invalid_bug", "Invalid bug id.", 400);
      const conn = await connection(userId);
      if (!conn) throw new ServiceError("not_connected", "Connect a GitHub repository first (Dashboard → Settings).", 409);
      const repo = conn.repo;
      const token = tokenOf(conn, userId);

      const bug = await ownedBug(userId, key, url);
      const evidence = evidenceFor(bug);
      if (!hasEnoughDetail(evidence)) {
        throw new ServiceError("not_enough_detail", "This bug doesn't have enough recorded detail for a useful issue. Re-scan the page first.", 422);
      }

      // ---- claim (the unique index makes this atomic across requests)
      const filter = { userId, bugKey: key, repo };
      const claimId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const at = now();
      let previous = null;
      try {
        await tickets().insertOne({ ...filter, status: "creating", claimId, claimedAt: at, attempts: 1, createdAt: at, updatedAt: at });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        previous = await tickets().findOne(filter);
        if (previous?.status === "created") return { ...publicTicket(previous), reused: true };
        const takeOver = { $set: { status: "creating", claimId, claimedAt: at, updatedAt: at }, $inc: { attempts: 1 } };
        const claimed =
          (await tickets().findOneAndUpdate({ ...filter, status: "failed" }, takeOver)) ||
          (await tickets().findOneAndUpdate({ ...filter, status: "creating", claimedAt: { $lt: new Date(at - STALE_MS) } }, takeOver));
        if (!claimed) {
          const latest = await tickets().findOne(filter);
          if (latest?.status === "created") return { ...publicTicket(latest), reused: true };
          throw new ServiceError("in_progress", "An issue for this bug is already being created. Try again in a moment.", 409);
        }
      }
      const mine = { ...filter, claimId };
      const fail = (err) =>
        tickets()
          .updateOne(mine, { $set: { status: "failed", error: err.code || "error", updatedAt: now() } })
          .catch(() => {});
      const saveCreated = async (issue, reused, location) => {
        const issueUrl = safeIssueUrl(issue.html_url, repo);
        if (!issueUrl) throw new GitHubError("github_error", "GitHub returned an unexpected issue address.");
        const result = { status: "created", repo, issueNumber: issue.number, issueUrl, reused, location: publicLocation(location) };
        try {
          await tickets().updateOne(mine, { $set: { status: "created", issueNumber: issue.number, issueUrl, error: null, updatedAt: now() } });
        } catch {
          // The issue exists; a later request finds it again by its marker.
          result.warning = "The issue was created but BugOps couldn't save the link. It will be found again on the next try.";
        }
        return result;
      };

      const github = makeClient(token);
      const marker = issueMarker(userId, key);
      try {
        // An earlier attempt may have created the issue before failing.
        if (previous) {
          const since = new Date(new Date(previous.createdAt || at).getTime() - 60 * 1000);
          const found = await github.findIssueByMarker(repo, marker, since);
          if (found) return await saveCreated(found, true, null);
        }
        // Missing code access or screenshots never block the issue itself.
        const location = await locationFor(userId, conn, github, key, evidence).catch(() => null);
        const screenshot = await screenshotFor(conn, github, evidence, bug);
        const issue = await github.createIssue(repo, buildIssue(evidence, { marker, location, screenshot }));
        return await saveCreated(issue, false, location);
      } catch (err) {
        await fail(err);
        throw err;
      }
    },
  };
}
