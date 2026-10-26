// Must be the first import: crawler modules read limits from .env at load time.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { analyzePageWorkflow } from "./browser.js";
import { answerScan, describeScan, getScan, shutdownScans, startScan, stopScan } from "./crawler/scanManager.js";
import { getTestRun, startTestRun } from "./testlib/jobs.js";
import { closeDb, connectDb } from "./db.js";
import { authRouter, requireAuth } from "./auth.js";
import { listUserScans, recordScanEnd, recordScanStart, userBugops } from "./userScans.js";
import { recallCredentials, rememberCredentials } from "./credentialStore.js";
import { cleanCredentials } from "./crawler/login.js";
import { closeScanCache } from "./crawler/scanCache.js";
import { shutdownTestBrowsers } from "./testlib/runner.js";
import { publicHttpUrlError } from "./urlSafety.js";

const app = express();
const defaultOrigins = ["http://localhost:5173", "http://localhost:8080"];
const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || defaultOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
}));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function userRateLimit(limit, windowMs) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = String(req.user._id);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
    }
    if (bucket.count >= limit) {
      const retrySeconds = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000));
      res.set("Retry-After", String(retrySeconds));
      return res.status(429).json({ success: false, error: "Too many requests. Please try again later." });
    }
    bucket.count++;
    buckets.set(key, bucket);
    if (buckets.size > 1000) {
      for (const [id, value] of buckets) {
        if (now - value.startedAt >= windowMs) buckets.delete(id);
      }
    }
    next();
  };
}

const limitScanStarts = userRateLimit(10, 60 * 60 * 1000);
const limitAnalyses = userRateLimit(20, 60 * 60 * 1000);

// ---- Accounts: signup, login, logout, me. Everything below needs a login.
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);

// A scan or test run is only visible to the user who started it.
const ownedBy = (job, req) => job && String(job.userId) === String(req.user._id);

app.post("/api/analyze", limitAnalyses, async (req, res) => {
  const { url } = req.body;
  const urlError = await publicHttpUrlError(url);
  if (urlError) {
    return res.status(400).json({ success: false, error: urlError });
  }

  try {
    const result = await analyzePageWorkflow(url);
    res.json({ success: true, url, analysis: result });
  } catch (err) {
    console.error("Analysis error:", err);
    res
      .status(500)
      .json({
        success: false,
        error: err.message || "An unexpected error occurred during analysis.",
      });
  }
});

// ---- Multi-page crawl (LangGraph). Long-running: start it, then poll.

// Starts a crawl and returns its id immediately.
// Body: { url, credentials?: { username, password } }. Without credentials the
// agent asks (via the pending question) when it meets a login form.
app.post("/api/scan", limitScanStarts, async (req, res) => {
  const { url, credentials } = req.body;
  const urlError = await publicHttpUrlError(url);
  if (urlError) {
    return res.status(400).json({ success: false, error: urlError });
  }
  const scan = startScan(url, {
    userId: req.user._id,
    authSessionId: req.sessionId,
    credentials: cleanCredentials(credentials),
    // Lets a later Re-Scan of this site log in the same way.
    onLogin: (creds) => rememberCredentials(req.user._id, url, creds),
    onEvent: (e) => console.log(`[${scan.scanId}] ${e.type}: ${e.message}`),
  });
  scan.userId = req.user._id;
  await recordScanStart({ userId: req.user._id, kind: "crawl", runId: scan.scanId, url });
  scan.done
    .then((report) => recordScanEnd(scan.scanId, { report }))
    .catch((err) => {
      console.error(`[${scan.scanId}] failed:`, err);
      return recordScanEnd(scan.scanId, { error: err.message });
    })
    .catch((err) => console.error(`[${scan.scanId}] could not record result:`, err));
  res.status(202).json({ success: true, scanId: scan.scanId });
});

// Status, progress events, pending question (if paused) and final report.
app.get("/api/scan/:id", (req, res) => {
  const scan = getScan(req.params.id);
  if (!ownedBy(scan, req)) return res.status(404).json({ success: false, error: "Scan not found" });
  res.json({ success: true, ...describeScan(scan) });
});

// Answers the pending question: { "answer": "approve" | "skip" | "fill" | "fill_submit" | "credentials" }
// A login question answered "credentials" also sends { credentials: { username, password } }.
app.post("/api/scan/:id/answer", (req, res) => {
  if (!ownedBy(getScan(req.params.id), req)) return res.status(404).json({ success: false, error: "Scan not found" });
  const credentials = cleanCredentials(req.body?.credentials);
  if (req.body?.answer === "credentials" && !credentials) {
    return res.status(400).json({ success: false, error: "Enter both a username/email and a password" });
  }
  const ok = answerScan(req.params.id, req.body?.answer, credentials);
  if (!ok) return res.status(409).json({ success: false, error: "Scan is not waiting for an answer" });
  res.json({ success: true });
});

// Stops early; a report is still written from what was found so far.
app.post("/api/scan/:id/stop", (req, res) => {
  if (!ownedBy(getScan(req.params.id), req)) return res.status(404).json({ success: false, error: "Scan not found" });
  const ok = stopScan(req.params.id);
  if (!ok) return res.status(409).json({ success: false, error: "Scan is not running" });
  res.json({ success: true });
});

// ---- Reusable test library. Also long-running: start it, then poll.

// Body: { url, allowMutations?, credentials?: { username, password }, maxPages? }
app.post("/api/tests", limitScanStarts, async (req, res) => {
  const { url, allowMutations, credentials, maxPages } = req.body || {};
  const urlError = await publicHttpUrlError(url);
  if (urlError) {
    return res.status(400).json({ success: false, error: urlError });
  }
  const options = {};
  if (typeof allowMutations === "boolean") options.allowMutations = allowMutations;
  // Explicit credentials, else the ones given for this site in an earlier scan.
  const login = cleanCredentials(credentials) || recallCredentials(req.user._id, url);
  if (login) options.credentials = login;
  if (Number.isInteger(maxPages) && maxPages > 0) options.maxPages = Math.min(maxPages, 20);
  const run = startTestRun(url, options, { userId: req.user._id });
  await recordScanStart({ userId: req.user._id, kind: "tests", runId: run.runId, url });
  run.done
    .then(() => recordScanEnd(run.runId, { error: run.status === "error" ? run.error : null }))
    .catch((err) => console.error(`[${run.runId}] could not record result:`, err));
  res.status(202).json({ success: true, runId: run.runId });
});

// Status, progress events and (when done) the test cases + BugOps rows.
app.get("/api/tests/:id", (req, res) => {
  const run = getTestRun(req.params.id);
  if (!ownedBy(run, req)) return res.status(404).json({ success: false, error: "Test run not found" });
  const { runId, url, status, events, error, result } = run;
  res.json({ success: true, runId, url, status, events, error, result });
});

// Dashboard rows for ?url= (or the user's most recent scan): the user's latest
// crawl (Scan page) and latest test run (Re-Scan) for it, merged.
app.get("/api/bugops", async (req, res) => {
  res.json({ success: true, ...(await userBugops(req.user._id, req.query.url)) });
});

// The user's scanned URLs, most recent first ("Recently scanned").
app.get("/api/scans", async (req, res) => {
  res.json({ success: true, scans: await listUserScans(req.user._id) });
});

// Unexpected errors (e.g. the database went away) → JSON, not an HTML page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: "Something went wrong on the server" });
});

const port = process.env.PORT || 3000;
try {
  await connectDb();
} catch (err) {
  console.error(`Could not connect to MongoDB: ${err.message}`);
  console.error("Set MONGODB_URI in backend/.env and make sure MongoDB is running.");
  process.exit(1);
}
const server = app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();
  server.close();
  await Promise.allSettled([
    shutdownScans(),
    shutdownTestBrowsers(),
  ]);
  await Promise.allSettled([closeScanCache(), closeDb()]);
  clearTimeout(forceExit);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
