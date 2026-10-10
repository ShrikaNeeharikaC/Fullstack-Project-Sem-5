// Must be the first import: crawler modules read limits from .env at load time.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { analyzePageWorkflow } from "./browser.js";
import { answerScan, describeScan, getScan, startScan, stopScan } from "./crawler/scanManager.js";

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
app.post("/api/scan", (req, res) => {
  const { url } = req.body;
  const urlError = validateUrl(url);
  if (urlError) {
    return res.status(400).json({ success: false, error: urlError });
  }
  const scan = startScan(url, {
    onEvent: (e) => console.log(`[${scan.scanId}] ${e.type}: ${e.message}`),
  });
  scan.done.catch((err) => console.error(`[${scan.scanId}] failed:`, err));
  res.status(202).json({ success: true, scanId: scan.scanId });
});

// Status, progress events, pending question (if paused) and final report.
app.get("/api/scan/:id", (req, res) => {
  const scan = getScan(req.params.id);
  if (!scan) return res.status(404).json({ success: false, error: "Scan not found" });
  res.json({ success: true, ...describeScan(scan) });
});

// Answers the pending question: { "answer": "approve" | "skip" | "fill" | "fill_submit" }
app.post("/api/scan/:id/answer", (req, res) => {
  const ok = answerScan(req.params.id, req.body?.answer);
  if (!ok) return res.status(409).json({ success: false, error: "Scan is not waiting for an answer" });
  res.json({ success: true });
});

// Stops early; a report is still written from what was found so far.
app.post("/api/scan/:id/stop", (req, res) => {
  const ok = stopScan(req.params.id);
  if (!ok) return res.status(409).json({ success: false, error: "Scan is not running" });
  res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
