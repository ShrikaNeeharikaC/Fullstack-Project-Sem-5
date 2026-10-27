import { check, errorChecks } from "../checks.js";

const NOT_FOUND = /\b(404|not found|doesn['’]t exist|does not exist|no longer available|not available|can['’]t find|cannot find|couldn['’]t find|could not find)\b/i;
// Framework error pages and stack traces that should never reach users.
const STACK_TRACE = /Traceback \(most recent call last\)|\bat \S+ \([^)]*:\d+:\d+\)|Exception in thread|Stack trace:|Whitelabel Error Page|Cannot GET \/|<b>Fatal error<\/b>/;

// URL of a page that cannot exist, in the same routing style as the site.
function missingUrl(url) {
  const u = new URL(url);
  const slug = `bugops-missing-${Date.now().toString(36)}`;
  if (u.hash.startsWith("#/")) return `${u.origin}${u.pathname}#/${slug}`;
  return `${u.origin}/${slug}`;
}

// Page-level: what a mistyped or stale URL shows.
export default {
  id: "not-found",
  name: "Unknown URLs show a proper 404 page",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "low",
  spec: {
    action: "Open a URL on the site that cannot exist",
    expectedNetwork: "Document returns HTTP 404 (not 200, not 5xx)",
    expectedStateChange: "A friendly 'not found' message with a way back to the site; no stack trace",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Add a catch-all route that renders a 'Page not found' view with a link home, and make the server answer unknown paths with status 404 (for SPAs, serve the app with 404 or render the view client-side).",

  async run(t) {
    const url = missingUrl(t.url);
    const hashRoute = url.includes("#/");
    await t.page.goto("about:blank");
    let status = null;
    const obs = await t.act(`Open a URL that does not exist: ${url}`, async () => {
      const res = await t.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      status = res?.status() ?? null;
    });

    const page = await t.page
      .evaluate(() => ({
        text: document.body?.innerText || "",
        html: document.documentElement.outerHTML.slice(0, 200000),
        links: [...document.querySelectorAll("a[href]")].filter((a) => a.getBoundingClientRect().width > 0).length,
      }))
      .catch(() => ({ text: "", html: "", links: 0 }));
    const saysNotFound = NOT_FOUND.test(page.text);
    const trace = STACK_TRACE.exec(page.html)?.[0];

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Server does not crash on unknown URLs", status === null || status < 500, {
          expected: "HTTP 404",
          actual: obs.error || `HTTP ${status}`,
          severity: "high",
          issue: `Unknown URL causes a server error (HTTP ${status})`,
        }),
        check("Unknown URL returns HTTP 404", hashRoute || status === 404 || status === 410, {
          expected: "HTTP 404 or 410",
          actual: hashRoute ? "n/a (hash route, server always answers 200)" : `HTTP ${status}`,
          severity: "low",
          // A 200 here is a "soft 404": search engines index the error page.
          soft: status !== null && status < 400,
          issue: `Unknown URL answers HTTP ${status} instead of 404`,
        }),
        check("User is told the page doesn't exist", saysNotFound, {
          expected: "'not found' message",
          actual: saysNotFound ? page.text.split("\n").find((l) => NOT_FOUND.test(l))?.slice(0, 100) : `no such message (${page.text.trim().length} chars of text)`,
          severity: "low",
          issue: "Unknown URLs show a blank or unrelated page instead of 'not found'",
        }),
        check("404 page links back into the site", page.links > 0, {
          expected: "at least one visible link (home, navigation)",
          actual: `${page.links} links`,
          severity: "low",
          issue: "404 page is a dead end (no links back to the site)",
        }),
        check("No stack trace or framework error page", !trace, {
          expected: "no internal error details",
          actual: trace ? trace.slice(0, 120) : "none",
          severity: "medium",
          issue: "404 page exposes a stack trace / framework error page",
        }),
        ...errorChecks(obs, { what: "opening an unknown URL", jsSeverity: "low" }).filter((c) => c.name !== "No failed API calls (4xx)"),
      ],
    };
  },
};
