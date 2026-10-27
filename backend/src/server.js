// Must be the first import: crawler modules read limits from .env at load time.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { analyzePageWorkflow } from "./browser.js";
import { answerScan, describeScan, getScan, startScan, stopScan } from "./crawler/scanManager.js";
import { getTestRun, startTestRun } from "./testlib/jobs.js";
import { bugSources, connectDb, integrations, tickets } from "./db.js";
import { authRouter, requireAuth } from "./auth.js";
import { findUserBug, listUserScans, recordScanEnd, recordScanStart, userBugops } from "./userScans.js";
import { githubService } from "./github/service.js";
import { githubRouter } from "./github/routes.js";
import { recallCredentials, rememberCredentials } from "./credentialStore.js";
import { cleanCredentials } from "./crawler/login.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

// Returns an error message if the URL is unusable, otherwise null.
function validateUrl(url) {
  if (!url) return "URL is required";
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return "Only http and https URLs are allowed";
    }
  } catch (err) {
    return "Invalid URL";
  }
  return null;
}

// ---- Accounts: signup, login, logout, me. Everything below needs a login.
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);

// A scan or test run is only visible to the user who started it.
const ownedBy = (job, req) => job && String(job.userId) === String(req.user._id);

// ---- GitHub Issues: connect a repository, create an issue for a bug.
const github = githubService({ integrations, tickets, sources: bugSources, findBug: findUserBug });
app.use("/api", githubRouter(github));

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body;
  const urlError = validateUrl(url);
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
app.post("/api/scan", async (req, res) => {
  const { url, credentials } = req.body;
  const urlError = validateUrl(url);
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
app.post("/api/tests", async (req, res) => {
  const { url, allowMutations, credentials, maxPages } = req.body || {};
  const urlError = validateUrl(url);
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
// Each row carries its GitHub issue (for the connected repository), if any.
app.get("/api/bugops", async (req, res) => {
  const data = await userBugops(req.user._id, req.query.url);
  const [conn, ticketMap] = await Promise.all([
    github.getConnection(req.user._id),
    github.ticketsFor(req.user._id, data.rows.map((r) => r.key)),
  ]);
  for (const row of data.rows) row.ticket = ticketMap[row.key] || null;
  res.json({ success: true, ...data, github: conn });
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
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
