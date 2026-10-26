import { check } from "../checks.js";

// Sites that block automated clients answer with these; not a broken link.
const BOT_BLOCKED = new Set([401, 403, 429, 999]);
// Often our machine's certificate store, not the site; reported separately.
const TLS_ERROR = /certificate|ssl|tls|self.signed/i;
const CONCURRENCY = 6;

async function status(request, url) {
  try {
    let res = await request.head(url, { timeout: 15000, maxRedirects: 5 });
    // Plenty of servers don't implement HEAD; ask again with GET.
    if ([404, 405, 501].includes(res.status())) res = await request.get(url, { timeout: 15000, maxRedirects: 5 });
    return { url, status: res.status() };
  } catch (err) {
    return { url, status: null, error: err.message.split("\n")[0].slice(0, 120) };
  }
}

// Page-level: every link on the page, checked by request (no clicking).
// nav-link clicks a few links deeply; this one covers all of them shallowly.
export default {
  id: "link-checker",
  name: "No broken links on the page",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Collect every http(s) link on the page and request each one (HEAD, falling back to GET)",
    expectedNetwork: "Every link target returns HTTP < 400",
    expectedStateChange: "n/a",
    persistsOnReload: "n/a",
  },
  fixHint: "Update or remove the links listed as broken; for moved pages, add a redirect from the old URL.",

  async run(t) {
    const max = t.options.maxLinkChecks || 40;
    await t.page.goto("about:blank");
    const load = await t.act("Load the page and collect its links", () => t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }));

    const hrefs = await t.page.evaluate(() =>
      [...document.querySelectorAll("a[href]")]
        .map((a) => a.href.split("#")[0])
        .filter((h) => /^https?:/.test(h)),
    );
    const unique = [...new Set(hrefs)];
    if (!unique.length) return { skipped: "The page has no links" };
    // Same-site links first: those are the ones the site owner controls.
    const targets = [...unique.filter((u) => t.sameSite(u)), ...unique.filter((u) => !t.sameSite(u))].slice(0, max);

    const request = t.page.context().request;
    const results = [];
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      results.push(...(await Promise.all(targets.slice(i, i + CONCURRENCY).map((u) => status(request, u)))));
    }

    const tls = results.filter((r) => r.status === null && TLS_ERROR.test(r.error));
    const broken = (r) => !tls.includes(r) && (r.status === null || (r.status >= 400 && !BOT_BLOCKED.has(r.status)));
    const internal = results.filter((r) => t.sameSite(r.url) && broken(r));
    const external = results.filter((r) => !t.sameSite(r.url) && broken(r));
    const list = (arr) => arr.slice(0, 5).map((r) => `${r.url} → ${r.error || r.status}`).join("; ") || "none";
    const checked = `${results.length} of ${unique.length} links checked`;

    return {
      primary: load,
      persistsOnReload: null,
      checks: [
        check("Internal links work", internal.length === 0, {
          expected: `every same-site link returns HTTP < 400 (${checked})`,
          actual: list(internal),
          severity: "medium",
          issue: `${internal.length} broken internal link${internal.length === 1 ? "" : "s"} on the page`,
        }),
        check("External links work", external.length === 0, {
          expected: "every external link responds",
          actual: list(external),
          severity: "low",
          issue: `${external.length} broken external link${external.length === 1 ? "" : "s"} on the page`,
        }),
        check("Link targets have valid certificates", tls.length === 0, {
          expected: "TLS verifies for every https link",
          actual: list(tls),
          severity: "low",
          soft: true,
        }),
        check("All links were checked", unique.length <= max, {
          expected: `≤ ${max} links (raise maxLinkChecks to check more)`,
          actual: checked,
          severity: "low",
          soft: true,
        }),
      ],
    };
  },
};
