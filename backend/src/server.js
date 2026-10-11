// Must be the first import: crawler modules read limits from .env at load time.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { analyzePageWorkflow } from "./browser.js";
import { answerScan, describeScan, getScan, startScan, stopScan } from "./crawler/scanManager.js";
import { getTestRun, startTestRun } from "./testlib/jobs.js";
import { connectDb } from "./db.js";
import { authRouter, requireAuth } from "./auth.js";
import { listUserScans, recordScanEnd, recordScanStart, userBugops } from "./userScans.js";

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
app.post("/api/scan", async (req, res) => {
  const { url } = req.body;
  const urlError = validateUrl(url);
  if (urlError) {
    return res.status(400).json({ success: false, error: urlError });
  }
  const scan = startScan(url, {
    onEvent: (e) => console.log(`[${scan.scanId}] ${e.type}: ${e.message}`),
  });
  scan.userId = req.user._id;
  await recordScanStart({ userId: req.user._id, kind: "crawl", runId: scan.scanId, url });
  scan.done
    .then(() => recordScanEnd(scan.scanId))
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

// Answers the pending question: { "answer": "approve" | "skip" | "fill" | "fill_submit" }
app.post("/api/scan/:id/answer", (req, res) => {
  if (!ownedBy(getScan(req.params.id), req)) return res.status(404).json({ success: false, error: "Scan not found" });
  const ok = answerScan(req.params.id, req.body?.answer);
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
  if (credentials?.username && credentials?.password) options.credentials = credentials;
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
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
