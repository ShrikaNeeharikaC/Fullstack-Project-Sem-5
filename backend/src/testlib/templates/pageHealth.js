import { check, consoleErrors, errorChecks, failedCalls, isThirdParty, jsErrors, listCalls, listConsole } from "../checks.js";

// Page-level: does the page load cleanly, with no console errors?
export default {
  id: "console-errors",
  name: "Page loads without errors",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page",
    expectedNetwork: "Main document returns HTTP < 400; no API call returns 4xx/5xx",
    expectedStateChange: "Page renders with no uncaught JavaScript exceptions or console errors",
    persistsOnReload: "Same clean result after a reload",
  },
  fixHint: "Open the browser console on this page, fix the first logged error, and check the failing requests in the Network tab.",

  async run(t) {
    // Start from a blank tab so this is a real load, not a same-page hash change.
    await t.page.goto("about:blank");
    let status = null;
    const load = await t.act("Load the page", async () => {
      const res = await t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      status = res?.status() ?? null;
    });
    const errors = consoleErrors(load).filter((c) => !isThirdParty(c, t.url));
    const thirdPartyErrors = consoleErrors(load).filter((c) => isThirdParty(c, t.url));

    const reload = await t.reload();
    const cleanAfterReload = jsErrors(reload).length === 0 && failedCalls(reload, 500).length === 0;

    return {
      primary: load,
      persistsOnReload: cleanAfterReload,
      checks: [
        check("Page responds with HTTP < 400", !load.error && status !== null && status < 400, {
          expected: "HTTP 2xx/3xx",
          actual: load.error || `HTTP ${status ?? "no response"}`,
          severity: "high",
          issue: `Page does not load (${load.error ? "navigation failed" : `HTTP ${status}`})`,
        }),
        ...errorChecks(load, { what: "page load" }),
        check("No console errors", errors.length === 0, {
          expected: "0 console errors",
          actual: `${errors.length}: ${listConsole(errors)}`,
          severity: "low",
          issue: `${errors.length} console error${errors.length === 1 ? "" : "s"} on page load`,
        }),
        check("No console errors from third-party scripts", thirdPartyErrors.length === 0, {
          expected: "0 errors from other sites' scripts",
          actual: `${thirdPartyErrors.length}: ${listConsole(thirdPartyErrors)}`,
          severity: "low",
          soft: true,
        }),
        check("No failed requests", load.network.filter((n) => n.failure && !n.blocked).length === 0, {
          expected: "every request completes",
          actual: listCalls(load.network.filter((n) => n.failure && !n.blocked)),
          severity: "low",
          soft: true,
        }),
        check("Still clean after a reload", cleanAfterReload, {
          expected: "no exceptions or 5xx on reload",
          actual: cleanAfterReload ? "clean" : `${jsErrors(reload).length} exceptions, ${failedCalls(reload, 500).length} 5xx`,
          severity: "medium",
          issue: "Errors appear when the page is reloaded",
        }),
      ],
    };
  },
};
