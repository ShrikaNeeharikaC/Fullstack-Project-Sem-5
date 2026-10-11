import { Command } from "@langchain/langgraph";
import { buildCrawlGraph } from "./graph.js";
import { closeSession, createSession, emit, markPaused, markRunning } from "./session.js";

const graph = buildCrawlGraph();
const scans = new Map();

// Starts a crawl in the background.
//   askUser(question) -> Promise<answer value>   called whenever the graph pauses
//   onEvent(event)                                optional progress callback
// Returns the scan record; scan.done resolves with the final report.
export function startScan(url, { askUser, onEvent, userId, authSessionId } = {}) {
  const scanId = `scan-${Date.now()}`;
  const session = createSession(scanId);
  session.onEvent = onEvent || null;
  session.userId = userId == null ? null : String(userId);
  session.authSessionId = authSessionId || null;
  session.scanUrl = url;

  const scan = {
    scanId,
    url,
    status: "running",
    question: null,
    report: null,
    error: null,
    events: session.events,
    session,
    resolveAnswer: null,
  };
  scans.set(scanId, scan);

  const ask =
    askUser ||
    // Default (HTTP): wait until answerScan() is called for this scan.
    ((question) =>
      new Promise((resolve) => {
        scan.resolveAnswer = resolve;
      }));

  scan.done = run(scan, ask);
  return scan;
}

async function run(scan, ask) {
  const config = { configurable: { thread_id: scan.scanId }, recursionLimit: 10000 };
  let input = { scanId: scan.scanId, startUrl: scan.url };

  try {
    markRunning(scan.session);
    for (;;) {
      await graph.invoke(input, config);
      const snapshot = await graph.getState(config);
      const pending = snapshot.tasks.flatMap((t) => t.interrupts || [])[0];

      if (!pending) {
        scan.report = snapshot.values.finalReport;
        scan.status = "done";
        return scan.report;
      }

      // The graph is paused inside the approve node, waiting for the user.
      markPaused(scan.session);
      scan.status = "waiting_for_user";
      scan.question = pending.value;
      emit(scan.session, "question", pending.value.question, { question: pending.value });

      const answer = await ask(pending.value);

      scan.question = null;
      scan.resolveAnswer = null;
      scan.status = "running";
      markRunning(scan.session);
      input = new Command({ resume: answer });
    }
  } catch (err) {
    scan.status = "error";
    scan.error = err.message;
    emit(scan.session, "error", err.message);
    throw err;
  } finally {
    markPaused(scan.session);
    await closeSession(scan.scanId);
  }
}

export function getScan(scanId) {
  return scans.get(scanId) || null;
}

// Supplies the user's answer to a paused scan.
export function answerScan(scanId, answer) {
  const scan = scans.get(scanId);
  if (!scan || scan.status !== "waiting_for_user" || !scan.resolveAnswer) return false;
  scan.resolveAnswer(answer);
  return true;
}

// Requests an early stop. The crawl finishes its current action, then writes
// a report from what it found so far. A pending question is answered "skip".
export function stopScan(scanId) {
  const scan = scans.get(scanId);
  if (!scan || (scan.status !== "running" && scan.status !== "waiting_for_user")) return false;
  scan.session.stopRequested = true;
  scan.resolveAnswer?.("skip");
  return true;
}

// Public view of a scan (no live objects).
export function describeScan(scan) {
  return {
    scanId: scan.scanId,
    url: scan.url,
    status: scan.status,
    question: scan.question,
    error: scan.error,
    events: scan.events,
    report: scan.report,
  };
}
