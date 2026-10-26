import { check } from "../checks.js";

// Page-level: the tags search engines and link previews read.
export default {
  id: "seo-meta",
  name: "Page has SEO and link-preview metadata",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "low",
  spec: {
    action: "Load the page and read its <head> and robots directives",
    expectedNetwork: "n/a",
    expectedStateChange: "Title, meta description, viewport, canonical and Open Graph tags are present; page is not accidentally noindex",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Keep the <title> to 10–60 chars, add, a <meta name=\"description\"> (50–160 chars), a viewport meta tag, a <link rel=\"canonical\">, og:title/og:description/og:image, and remove noindex from pages that should be found.",

  async run(t) {
    await t.page.goto("about:blank");
    let robotsHeader = "";
    const load = await t.act("Load the page and read its metadata", async () => {
      const res = await t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      robotsHeader = (res && (await res.headerValue("x-robots-tag"))) || "";
    });

    const m = await t.page.evaluate(() => {
      const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
      return {
        title: document.title.trim(),
        description: meta('meta[name="description"]'),
        viewport: meta('meta[name="viewport"]'),
        robots: meta('meta[name="robots"]'),
        canonical: document.querySelector('link[rel="canonical"]')?.href || "",
        ogTitle: meta('meta[property="og:title"]'),
        ogDescription: meta('meta[property="og:description"]'),
        ogImage: meta('meta[property="og:image"]'),
        h1s: document.querySelectorAll("h1").length,
      };
    });

    const noindex = /noindex/i.test(`${m.robots} ${robotsHeader}`);
    const missingOg = [!m.ogTitle && "og:title", !m.ogDescription && "og:description", !m.ogImage && "og:image"].filter(Boolean);
    const canonicalOk = !m.canonical || t.sameSite(m.canonical);

    return {
      primary: load,
      persistsOnReload: null,
      checks: [
        check("Title has a useful length", m.title.length >= 10 && m.title.length <= 60, {
          expected: "10–60 characters",
          actual: `${m.title.length} chars: "${m.title.slice(0, 80)}"`,
          severity: "low",
          // A missing title is already an accessibility failure.
          soft: true,
        }),
        check("Meta description is present", m.description.length >= 50 && m.description.length <= 160, {
          expected: "50–160 characters",
          actual: m.description ? `${m.description.length} chars` : "missing",
          severity: "low",
          issue: m.description ? "Meta description length is outside 50–160 characters" : "Page has no meta description",
        }),
        check("Viewport meta tag is set", /width=device-width/i.test(m.viewport), {
          expected: "width=device-width, initial-scale=1",
          actual: m.viewport || "missing",
          severity: "medium",
          issue: "No viewport meta tag: the page renders zoomed-out on phones",
        }),
        check("Page is indexable", !noindex, {
          expected: "no noindex in meta robots or X-Robots-Tag",
          actual: noindex ? `robots: ${m.robots || robotsHeader}` : "indexable",
          severity: "medium",
          // Staging and local sites are often noindex on purpose.
          soft: true,
          issue: "Page tells search engines not to index it (noindex)",
        }),
        check("Canonical URL points to this site", canonicalOk, {
          expected: "same-site <link rel=canonical> (or none)",
          actual: m.canonical || "none",
          severity: "medium",
          issue: `Canonical URL points to another site: ${m.canonical}`,
        }),
        check("Exactly one h1", m.h1s === 1, {
          expected: "1 <h1>",
          actual: `${m.h1s}`,
          severity: "low",
          soft: true,
        }),
        check("Open Graph tags for link previews", missingOg.length === 0, {
          expected: "og:title, og:description, og:image",
          actual: missingOg.length ? `missing ${missingOg.join(", ")}` : "all present",
          severity: "low",
          soft: true,
        }),
      ],
    };
  },
};
