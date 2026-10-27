import { Command } from "@langchain/langgraph";
import { buildCrawlGraph } from "./graph.js";
import { closeSession, createSession, emit, markPaused, markRunning } from "./session.js";
import { cleanCredentials } from "./login.js";
import { runWithBus } from "../events/EventBus.js";
import { onProgress } from "../events/subscribers.js";

const graph = buildCrawlGraph();
const scans = new Map();

// Starts a crawl in the background.
//   askUser(question) -> Promise<answer value>   called whenever the graph pauses
//   onEvent(event)                                optional progress callback
//   credentials { username, password }            optional: log in without asking
//   onLogin(credentials)                          optional: called after a successful login
// Returns the scan record; scan.done resolves with the final report.
export function startScan(url, { askUser, onEvent, userId, authSessionId, credentials, onLogin } = {}) {
  const scanId = `scan-${Date.now()}`;
  const session = createSession(scanId);
  if (onEvent) onProgress(session.bus, onEvent);
  session.userId = userId == null ? null : String(userId);
  session.authSessionId = authSessionId || null;
  session.scanUrl = url;
  // Kept on the live session only: never in graph state, events or reports.
  session.credentials = cleanCredentials(credentials);
  session.onLogin = onLogin || null;

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

  // Runs inside the session's bus context so LLM calls made anywhere in the
  // crawl publish "llm_call" events to this scan.
  scan.done = runWithBus(session.bus, () => run(scan, ask));
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

      // An answer is an option value, or { value, credentials } for the
      // "Log in with my account" option of the login question.
      let answer = await ask(pending.value);
      if (answer && typeof answer === "object") {
        const credentials = cleanCredentials(answer.credentials);
        if (credentials) scan.session.credentials = credentials;
        answer = answer.value;
      }

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

// Supplies the user's answer to a paused scan (plus credentials when the
// answer to a login question is "credentials").
export function answerScan(scanId, answer, credentials = null) {
  const scan = scans.get(scanId);
  if (!scan || scan.status !== "waiting_for_user" || !scan.resolveAnswer) return false;
  scan.resolveAnswer(credentials ? { value: answer, credentials } : answer);
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
