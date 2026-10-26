import { check, errorChecks } from "../checks.js";
import { elementLabel } from "../elements.js";

const withoutHash = (u) => u.split("#")[0].replace(/\/$/, "");
// URLs equal for history purposes (hash routes keep their hash).
const sameUrl = (a, b) => (a.includes("#/") || b.includes("#/") ? a === b : withoutHash(a) === withoutHash(b));

const pageText = (page) =>
  page.evaluate(() => (document.body?.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean)).catch(() => []);

// Share of the original lines that are back on the page.
const overlap = (before, after) => {
  if (!before.length) return 1;
  const now = new Set(after);
  return before.filter((l) => now.has(l)).length / before.length;
};

// The browser's Back and Forward buttons, after following a link. SPAs that
// change the view without pushing history break this.
export default {
  id: "back-button",
  name: "Back and Forward buttons work after navigating",
  scope: "element",
  categories: ["nav"],
  kinds: ["link"],
  requires: [],
  onePerPage: true,
  severity: "medium",
  spec: {
    action: "Follow a same-site link, press Back, then press Forward",
    expectedNetwork: "Any document requests return HTTP < 400",
    expectedStateChange: "Back restores the original URL and content; Forward returns to the destination",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Navigate with your router (history.pushState / <Link>) instead of swapping views in place, and re-render from the URL on popstate so Back and Forward restore the right view.",

  appliesTo(el, t) {
    return el.kind === "link" && !!el.href && el.target !== "_blank" && t.sameSite(el.href) && !sameUrl(el.href, t.url);
  },

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();
    const startUrl = t.page.url();
    const startText = await pageText(t.page);

    const nav = await t.act(`Click ${label}`, async () => (await t.locate(el)).click({ timeout: 5000 }));
    const destUrl = nav.urlAfter;
    if (nav.error || sameUrl(destUrl, startUrl)) {
      return { skipped: `Following ${label} did not change the URL, so there is no history entry to go back to` };
    }

    const back = await t.act("Press the browser Back button", () => t.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }));
    const restored = overlap(startText, await pageText(t.page));
    const forward = await t.act("Press the browser Forward button", () => t.page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 }));

    return {
      primary: back,
      persistsOnReload: null,
      checks: [
        check("Back returns to the original URL", sameUrl(back.urlAfter, startUrl), {
          expected: startUrl,
          actual: back.error || back.urlAfter,
          severity: "medium",
          issue: `Back button does not return to the page after following ${label}`,
        }),
        check("Back restores the original content", restored >= 0.6, {
          expected: "≥ 60% of the original text back on the page",
          actual: `${Math.round(restored * 100)}% restored`,
          severity: "medium",
          issue: "Back button changes the URL but the old content does not come back",
        }),
        check("Forward returns to the destination", sameUrl(forward.urlAfter, destUrl), {
          expected: destUrl,
          actual: forward.error || forward.urlAfter,
          severity: "low",
          issue: "Forward button does not return to the page navigated to",
        }),
        ...errorChecks(back, { what: "pressing Back", jsSeverity: "low" }),
        ...errorChecks(forward, { what: "pressing Forward", jsSeverity: "low" }).map((c) => ({ ...c, name: `${c.name} (Forward)` })),
      ],
    };
  },
};
