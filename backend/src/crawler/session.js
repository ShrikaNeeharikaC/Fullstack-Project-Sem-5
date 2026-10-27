import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CRAWL_HEADLESS } from "./config.js";
import { chromeArgs } from "../browserArgs.js";
import { EventBus } from "../events/EventBus.js";
import { LlmUsageCounter, recordHistory } from "../events/subscribers.js";
import { validatePublicHttpUrl } from "../ciScan.js";

// The main takeaway
// The Map is for accessing live objects quickly; LangGraph checkpointing is for saving workflow data so it can resume.
// They solve two different problems, which is why your crawler uses both.

// Live Playwright objects can't be stored in LangGraph state (state must be
// plain serialisable data), so each scan's browser lives here, keyed by the
// scan id, which is also the LangGraph thread_id.
const sessions = new Map();

export function getSession(scanId) {
  const session = sessions.get(scanId);
  if (!session) throw new Error(`No browser session for scan ${scanId}`);
  return session;
}

export function createSession(scanId) {
  const session = {
    scanId,
    dir: path.join("artifacts", "scans", scanId),
    browser: null,
    context: null,
    page: null,
    // Error signals collected while an action runs (reset before each one).
    signals: [],
    // Progress events are published to the bus; subscribers decide where they go
    // (history below, plus whatever startScan attaches).
    bus: new EventBus(),
    events: [],
    // Time accounting: paused time (waiting on the user) is excluded.
    activeMs: 0,
    runningSince: null,
    stopRequested: false,
    llmCalls: 0,
    cache: { hits: 0, misses: 0, errors: 0, fingerprintMs: 0 },
    userId: null,
    authSessionId: null,
  };
  recordHistory(session.bus, session.events);
  // Every LLM call made during this scan counts against its budget.
  new LlmUsageCounter((count) => (session.llmCalls = count)).attach(session.bus);
  fs.mkdirSync(session.dir, { recursive: true });
  sessions.set(scanId, session);
  return session;
}

export async function openBrowser(session) {
  session.browser = await chromium.launch({ channel: "chrome", headless: CRAWL_HEADLESS, args: chromeArgs() });
  session.context = await session.browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (session.ciMode) {
    await session.context.route("**/*", async (route) => {
      const error = await validatePublicHttpUrl(route.request().url());
      if (error) return route.abort("blockedbyclient");
      return route.continue();
    });
  }
  session.page = await session.context.newPage();
  const page = session.page;
  const push = (signal) => session.signals.push({ ...signal, at: page.url() });

  // Where an error came from (stack trace / console call site) is kept so a
  // GitHub issue can point at the source line.
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location();
    push({
      type: "console_error",
      message: msg.text().slice(0, 500),
      ...(loc?.url ? { stack: `    at ${loc.url}:${(loc.lineNumber ?? 0) + 1}:${(loc.columnNumber ?? 0) + 1}` } : {}),
    });
  });
  page.on("pageerror", (err) =>
    push({
      type: "js_exception",
      message: String(err.message || err).slice(0, 500),
      stack: String(err.stack || "").split("\n").slice(0, 10).join("\n").slice(0, 2000),
    }),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) {
      push({
        type: "http_error",
        status: res.status(),
        url: res.url(),
        resourceType: res.request().resourceType(),
      });
    }
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText || "";
    // Aborted requests are normal when navigating away mid-load.
    if (!failure.includes("ERR_ABORTED")) {
      push({ type: "request_failed", url: req.url(), message: failure });
    }
  });
  // Never let alert()/confirm() dialogs block the crawl.
  page.on("dialog", (dialog) => {
    push({ type: "dialog", message: dialog.message().slice(0, 300) });
    dialog.dismiss().catch(() => {});
  });
  // Links that open new tabs: record and close them; the crawl stays in one tab.
  session.context.on("page", (popup) => {
    push({ type: "popup", url: popup.url() });
    popup.close().catch(() => {});
  });
}

export function emit(session, type, message, data = {}) {
  session.bus.emit(type, message, data);
}

export function markRunning(session) {
  session.runningSince = Date.now();
}

export function markPaused(session) {
  if (session.runningSince) {
    session.activeMs += Date.now() - session.runningSince;
    session.runningSince = null;
  }
}

export function activeMs(session) {
  return session.activeMs + (session.runningSince ? Date.now() - session.runningSince : 0);
}

export async function closeSession(scanId) {
  const session = sessions.get(scanId);
  if (!session) return;
  await session.browser?.close().catch(() => {});
  sessions.delete(scanId);
}
