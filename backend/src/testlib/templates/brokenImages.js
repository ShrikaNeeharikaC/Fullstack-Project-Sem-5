import { check } from "../checks.js";

// Page-level: every <img> loads, and has alt text.
export default {
  id: "broken-images",
  name: "Images load and have alt text",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page and scroll through it (to trigger lazy-loaded images)",
    expectedNetwork: "Every image request returns HTTP < 400",
    expectedStateChange: "Every <img> has non-zero natural size and an alt attribute",
    persistsOnReload: "n/a",
  },
  fixHint: "Fix or replace the image URLs that fail to load (check for moved CDN paths), and add descriptive alt text.",

  async run(t) {
    const load = await t.act("Load the page and scroll through it", async () => {
      await t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await t.page.evaluate(async () => {
        for (let i = 0; i < 15 && window.scrollY + innerHeight < document.body.scrollHeight; i++) {
          window.scrollBy(0, innerHeight);
          await new Promise((r) => setTimeout(r, 250));
        }
        window.scrollTo(0, 0);
      });
    });

    const images = await t.page.evaluate(() =>
      [...document.images].map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.getAttribute("alt"),
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        lazy: img.loading === "lazy",
        visible: img.getBoundingClientRect().width > 0,
      })),
    );

    const failedRequests = new Set(
      load.network.filter((n) => n.resourceType === "image" && (n.failure || (n.status ?? 0) >= 400)).map((n) => n.url),
    );
    const broken = images.filter(
      (img) => img.src && ((img.complete && img.naturalWidth === 0) || failedRequests.has(img.src)),
    );
    // alt="" is valid for decorative images; only a missing attribute is flagged.
    const noAlt = images.filter((img) => img.visible && img.src && img.alt === null);
    const list = (arr) => arr.slice(0, 5).map((i) => i.src.slice(0, 120)).join(", ");

    return {
      primary: load,
      persistsOnReload: null,
      checks: [
        check("All images load", broken.length === 0, {
          expected: `${images.length} images load`,
          actual: broken.length ? `${broken.length} broken: ${list(broken)}` : "all loaded",
          severity: "medium",
          issue: `${broken.length} broken image${broken.length === 1 ? "" : "s"} on the page`,
        }),
        check("Images have alt text", noAlt.length === 0, {
          expected: "every visible <img> has an alt attribute",
          actual: noAlt.length ? `${noAlt.length} missing alt: ${list(noAlt)}` : "all have alt",
          severity: "low",
          issue: `${noAlt.length} image${noAlt.length === 1 ? "" : "s"} missing alt text`,
        }),
      ],
    };
  },
};
