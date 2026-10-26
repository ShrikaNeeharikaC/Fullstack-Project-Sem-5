import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CRAWL_HEADLESS } from "./config.js";
import { installPublicNetworkGuard } from "../urlSafety.js";

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
    // Progress log, for the terminal now and the frontend later.
    events: [],
    onEvent: null,
    // Time accounting: paused time (waiting on the user) is excluded.
    activeMs: 0,
    runningSince: null,
    stopRequested: false,
    llmCalls: 0,
    cache: { hits: 0, misses: 0, errors: 0, fingerprintMs: 0 },
    userId: null,
    authSessionId: null,
  };
  fs.mkdirSync(session.dir, { recursive: true });
  sessions.set(scanId, session);
  return session;
}

export async function openBrowser(session) {
  session.browser = await chromium.launch({ headless: CRAWL_HEADLESS });
  session.context = await session.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installPublicNetworkGuard(session.context);
  session.page = await session.context.newPage();
  const page = session.page;
  const push = (signal) => session.signals.push({ ...signal, at: page.url() });

  page.on("console", (msg) => {
    if (msg.type() === "error") push({ type: "console_error", message: msg.text().slice(0, 500) });
  });
  page.on("pageerror", (err) => push({ type: "js_exception", message: String(err.message || err).slice(0, 500) }));
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
  const event = { at: new Date().toISOString(), type, message, ...data };
  session.events.push(event);
  session.onEvent?.(event);
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
