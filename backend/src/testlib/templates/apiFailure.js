import { check, jsErrors, listConsole } from "../checks.js";

const ERROR_MESSAGE = /error|went wrong|try again|failed|unable|unavailable|problem|couldn['’]t|could not|offline|no connection/i;

async function pageState(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
      };
      const spinners = [...document.querySelectorAll('[aria-busy="true"], [class*="spinner"], [class*="loading"], [class*="loader"], [role="progressbar"]')].filter(visible);
      return {
        lines: (document.body?.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean),
        spinners: spinners.length,
      };
    })
    .catch(() => ({ lines: [], spinners: 0 }));
}

// Page-level: what does the user see when the page's API is down?
export default {
  id: "api-failure",
  name: "Page handles API failures gracefully",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Reload the page with its API calls answered by a simulated 500, then with the network cut",
    expectedNetwork: "The page's own API calls (simulated failures)",
    expectedStateChange: "No uncaught exceptions; the page still renders and shows an error message instead of a blank screen or endless spinner",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Wrap API calls in try/catch (or .catch), check response.ok, and render an error state with a retry option instead of leaving the page blank or loading forever.",

  async run(t) {
    await t.page.goto("about:blank");
    const baseline = await t.act("Load the page normally", () => t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }));
    const apiUrls = new Set(
      baseline.network
        .filter((n) => ["fetch", "xhr"].includes(n.resourceType) && n.method === "GET" && t.sameSite(n.url) && (n.status ?? 0) < 400)
        .map((n) => n.url),
    );
    if (!apiUrls.size) return { skipped: "The page makes no API calls of its own on load" };
    const baseState = await pageState(t.page);

    const checks = [];
    let primary = null;
    for (const mode of ["500", "offline"]) {
      const matcher = (url) => apiUrls.has(url.toString());
      const handler = (route) =>
        mode === "500"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"simulated by BugOps"}' })
          : route.abort("internetdisconnected");
      await t.page.route(matcher, handler);
      let obs;
      try {
        await t.page.goto("about:blank");
        obs = await t.act(`Load the page with ${apiUrls.size} API call(s) ${mode === "500" ? "returning 500" : "offline"}`, () =>
          t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }),
        );
      } finally {
        await t.page.unroute(matcher, handler);
      }
      primary = primary || obs;
      const state = await pageState(t.page);
      // Any uncaught exception counts: an unhandled "Failed to fetch" is
      // exactly the missing error handling this test looks for.
      const js = jsErrors(obs);
      const blank = state.lines.length < Math.max(2, Math.floor(baseState.lines.length * 0.2));
      const newLines = state.lines.filter((l) => !baseState.lines.includes(l));
      const message = newLines.some((l) => ERROR_MESSAGE.test(l));
      const label = mode === "500" ? "when the API returns 500" : "when offline";

      checks.push(
        check(`No uncaught exceptions ${label}`, js.length === 0, {
          expected: "errors are caught",
          actual: listConsole(js),
          severity: "medium",
          issue: `Page throws an uncaught error ${label}`,
        }),
        check(`Page still renders ${label}`, !blank, {
          expected: "page content stays visible",
          actual: `${state.lines.length} lines of text (normally ${baseState.lines.length})`,
          severity: "high",
          issue: `Page goes blank ${label}`,
        }),
        check(`No endless loading spinner ${label}`, state.spinners <= baseState.spinners, {
          expected: "no spinner left running",
          actual: `${state.spinners} spinner(s) visible (normally ${baseState.spinners})`,
          severity: "medium",
          issue: `Page shows a loading spinner forever ${label}`,
        }),
        check(`User is told something went wrong ${label}`, message, {
          expected: "an error message",
          actual: message ? newLines.find((l) => ERROR_MESSAGE.test(l)) : "no error message",
          severity: "low",
          issue: `No error message is shown ${label}`,
        }),
      );
    }
    return { primary, persistsOnReload: null, checks };
  },
};
