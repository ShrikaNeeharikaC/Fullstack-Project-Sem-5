import { apiCalls, check, listCalls } from "../checks.js";

const KB = 1024;

// Thresholds follow Google's Core Web Vitals "poor" boundaries where one exists.
const LIMITS = { ttfbMs: 1800, lcpMs: 4000, loadMs: 8000, cls: 0.25, slowApiMs: 3000, pageBytes: 5 * KB * KB, imageBytes: 1 * KB * KB };

export default {
  id: "performance",
  name: "Page loads fast enough",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page from a blank tab and read the browser's performance timings",
    expectedNetwork: `Server answers within ${LIMITS.ttfbMs} ms; no API call takes over ${LIMITS.slowApiMs} ms; page weighs under 5 MB`,
    expectedStateChange: `Largest content paints within ${LIMITS.lcpMs} ms; layout shift (CLS) under ${LIMITS.cls}`,
    persistsOnReload: "n/a",
  },
  fixHint:
    "Compress and resize large images, cache or speed up the slow endpoints, and reserve space for late-loading content to avoid layout shift.",

  async run(t) {
    await t.page.goto("about:blank");
    const load = await t.act("Load the page and measure", () =>
      t.page.goto(t.url, { waitUntil: "load", timeout: 60000 }),
    );

    const m = await t.page.evaluate(
      () =>
        new Promise((resolve) => {
          let lcp = null;
          let cls = 0;
          try {
            new PerformanceObserver((list) => {
              const last = list.getEntries().at(-1);
              if (last) lcp = last.startTime;
            }).observe({ type: "largest-contentful-paint", buffered: true });
            new PerformanceObserver((list) => {
              for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value;
            }).observe({ type: "layout-shift", buffered: true });
          } catch {}
          setTimeout(() => {
            const nav = performance.getEntriesByType("navigation")[0];
            const resources = performance.getEntriesByType("resource");
            resolve({
              ttfb: nav ? nav.responseStart - nav.startTime : null,
              dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
              load: nav ? nav.loadEventEnd - nav.startTime : null,
              lcp,
              cls,
              bytes: (nav?.transferSize || 0) + resources.reduce((s, r) => s + (r.transferSize || 0), 0),
              bigImages: resources
                .filter((r) => r.initiatorType === "img" && (r.transferSize || r.encodedBodySize) > 1024 * 1024)
                .map((r) => `${r.name.slice(0, 100)} (${Math.round((r.transferSize || r.encodedBodySize) / 1024)} KB)`),
            });
          }, 1500);
        }),
    );

    const slowApis = apiCalls(load).filter((n) => n.resourceType !== "document" && (n.durationMs ?? 0) > LIMITS.slowApiMs);
    const ms = (v) => (v == null ? "n/a" : `${Math.round(v)} ms`);

    return {
      primary: load,
      persistsOnReload: null,
      metrics: m,
      checks: [
        check("Server responds quickly (TTFB)", m.ttfb == null || m.ttfb <= LIMITS.ttfbMs, {
          expected: `≤ ${LIMITS.ttfbMs} ms`,
          actual: ms(m.ttfb),
          severity: "low",
          issue: `Slow server response: ${ms(m.ttfb)} to first byte`,
        }),
        check("Main content appears quickly (LCP)", m.lcp == null || m.lcp <= LIMITS.lcpMs, {
          expected: `≤ ${LIMITS.lcpMs} ms`,
          actual: ms(m.lcp),
          severity: "medium",
          issue: `Slow page: main content takes ${ms(m.lcp)} to appear`,
        }),
        check("Page finishes loading", m.load == null || m.load <= LIMITS.loadMs, {
          expected: `≤ ${LIMITS.loadMs} ms`,
          actual: ms(m.load),
          severity: "medium",
          issue: `Slow page: full load takes ${ms(m.load)}`,
        }),
        check("Layout is stable (CLS)", m.cls <= LIMITS.cls, {
          expected: `CLS ≤ ${LIMITS.cls}`,
          actual: m.cls.toFixed(3),
          severity: "low",
          issue: `Content jumps around while loading (CLS ${m.cls.toFixed(2)})`,
        }),
        check("API calls are fast", slowApis.length === 0, {
          expected: `every API call ≤ ${LIMITS.slowApiMs} ms`,
          actual: slowApis.length ? slowApis.map((n) => `${listCalls([n])} in ${n.durationMs} ms`).join("; ") : "all fast",
          severity: "medium",
          issue: `${slowApis.length} slow API call(s) (over ${LIMITS.slowApiMs / 1000}s)`,
        }),
        check("Page weight is reasonable", m.bytes <= LIMITS.pageBytes, {
          expected: "≤ 5 MB transferred",
          actual: `${(m.bytes / KB / KB).toFixed(1)} MB`,
          severity: "low",
          issue: `Heavy page: ${(m.bytes / KB / KB).toFixed(1)} MB transferred`,
        }),
        check("No oversized images", m.bigImages.length === 0, {
          expected: "every image ≤ 1 MB",
          actual: m.bigImages.slice(0, 3).join(", ") || "none",
          severity: "low",
          issue: `${m.bigImages.length} image(s) over 1 MB`,
        }),
      ],
    };
  },
};
