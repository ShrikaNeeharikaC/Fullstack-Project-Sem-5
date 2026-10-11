import { check, errorChecks } from "../checks.js";
import { elementLabel } from "../elements.js";

const ERROR_PAGE = /\b(404|page not found|not found|doesn['’]t exist|does not exist|error 500|server error)\b/i;
// Sites that block automated clients answer with these; not a broken link.
const BOT_BLOCKED = new Set([401, 403, 429, 999]);

function samePage(a, b) {
  const strip = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "") + x.search + x.hash;
    } catch {
      return u;
    }
  };
  return strip(a) === strip(b);
}

export default {
  id: "nav-link",
  name: "Navigation link opens a working page",
  scope: "element",
  categories: ["nav", "generic", "auth", "search", "create", "upload"],
  kinds: ["link"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Click the link",
    expectedNetwork: "GET of the destination returns HTTP < 400 (none for client-side routes)",
    expectedStateChange: "URL changes to the link target and the destination is not an error page",
    persistsOnReload: "Reloading the destination URL gives the same page (HTTP < 400)",
  },
  fixHint: "Point the link at an existing page or restore the missing route; for SPA routes, make the server serve the app for deep links.",

  appliesTo(el, t) {
    return el.kind === "link" && !!el.href && !samePage(el.href, t.url);
  },

  async run(t, el) {
    const label = elementLabel(el);

    // Off-site links: check the target responds, but never leave the site.
    if (!t.sameSite(el.href)) {
      let status = null;
      let error = null;
      const obs = await t.act(`Request external link ${el.href}`, async () => {
        try {
          const res = await t.page.context().request.get(el.href, { timeout: 15000, maxRedirects: 5 });
          status = res.status();
        } catch (err) {
          error = err.message.split("\n")[0];
        }
      });
      const ok = status !== null && (status < 400 || BOT_BLOCKED.has(status));
      return {
        primary: obs,
        persistsOnReload: null,
        checks: [
          check("External link target responds", ok, {
            expected: "HTTP < 400",
            actual: error || `HTTP ${status}`,
            severity: "medium",
            issue: `External link ${label} is broken (${error ? "unreachable" : `HTTP ${status}`})`,
          }),
        ],
      };
    }

    await t.fresh();
    const nav = await t.act(`Click ${label}`, async () => {
      // target=_blank would open a new tab; follow the same URL in this tab.
      if (el.target === "_blank") await t.page.goto(el.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      else await (await t.locate(el)).click({ timeout: 5000 });
    });

    const docs = nav.network.filter((n) => n.resourceType === "document" && n.method === "GET");
    const doc = docs[docs.length - 1];
    const heading = await t.page
      .evaluate(() => `${document.title} | ${document.querySelector("h1")?.innerText || ""}`)
      .catch(() => "");
    // A document request also counts: links inside iframes navigate the
    // frame, which doesn't change the top page's URL or DOM.
    const moved = nav.diff.url.changed || nav.diff.dom.changed || !!doc;

    const reload = await t.reload();
    const reloadDoc = reload.network.find((n) => n.resourceType === "document");
    const persists = (reloadDoc?.status ?? 200) < 400 && samePage(reload.urlAfter, nav.urlAfter) && !ERROR_PAGE.test(
      await t.page.evaluate(() => `${document.title} | ${document.querySelector("h1")?.innerText || ""}`).catch(() => ""),
    );

    return {
      primary: nav,
      persistsOnReload: persists,
      checks: [
        check("Link is clickable", !nav.error, {
          expected: "click succeeds",
          actual: nav.error || "clicked",
          severity: "medium",
          issue: `Link ${label} cannot be clicked`,
        }),
        check("Destination responds with HTTP < 400", !doc || (doc.status ?? 0) < 400, {
          expected: "HTTP 2xx/3xx",
          actual: doc ? `HTTP ${doc.status ?? "no response"}${doc.failure ? ` (${doc.failure})` : ""}` : "client-side route (no document request)",
          severity: "medium",
          issue: `Broken link: ${label} returns HTTP ${doc?.status ?? "error"}`,
        }),
        check("Link leads somewhere", moved, {
          expected: "URL or page content changes",
          actual: moved ? nav.urlAfter : "nothing changed",
          severity: "medium",
          issue: `Link ${label} does nothing`,
        }),
        check("Destination is not an error page", !ERROR_PAGE.test(heading), {
          expected: "title/heading without 404 / not found",
          actual: heading.slice(0, 120),
          severity: "medium",
          issue: `Link ${label} lands on an error page`,
        }),
        ...errorChecks(nav, { what: `following ${label}`, jsSeverity: "low" }),
        check("Destination survives a reload", persists, {
          expected: "same URL, HTTP < 400 after reload",
          actual: `${reload.urlAfter} (HTTP ${reloadDoc?.status ?? "n/a"})`,
          severity: "medium",
          issue: `Deep link to ${nav.urlAfter} breaks on reload`,
        }),
      ],
    };
  },
};
