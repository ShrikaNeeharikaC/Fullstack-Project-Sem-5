import path from "path";
import * as playwright from "playwright";
import { check } from "../checks.js";
import { isSameSite } from "../observer.js";

// What a page looks like in one browser: errors and a rough layout fingerprint.
async function measure(page, url) {
  const errors = [];
  const failed = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 400 && isSameSite(r.url(), url)) failed.push(`${r.request().method()} ${r.url()} → ${r.status()}`);
  });
  let status = null;
  let loadError = null;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = res?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  } catch (err) {
    loadError = err.message.split("\n")[0];
  }
  const layout = await page
    .evaluate(() => {
      const visible = [...document.body.querySelectorAll("*")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      });
      return {
        visibleElements: visible.length,
        height: document.documentElement.scrollHeight,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        textLines: (document.body.innerText || "").split("\n").filter((l) => l.trim()).length,
      };
    })
    .catch(() => null);
  return { status, loadError, errors, failed, layout };
}

// Page-level: compare Chrome (the baseline) with Firefox and WebKit/Safari.
// Uses Playwright's own browser builds; missing ones are reported, not failed.
export default {
  id: "cross-browser",
  name: "Page works in Firefox and Safari (WebKit)",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page in Chrome, Firefox and WebKit at the same size and compare",
    expectedNetwork: "Same HTTP status and no extra failed requests in other browsers",
    expectedStateChange: "No browser-specific JavaScript errors; content and layout roughly match Chrome",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Check the browser-specific error in that browser's console: usually an API or CSS feature without a polyfill/fallback (e.g. newer Canvas, Intl or CSS functions).",

  async run(t) {
    const browsers = t.options.browsers || ["firefox", "webkit"];
    const viewport = { width: 1440, height: 900 };

    const basePage = await t.page.context().newPage();
    let base;
    try {
      base = await measure(basePage, t.url);
    } finally {
      await basePage.close();
    }

    const checks = [];
    const missing = [];
    for (const name of browsers) {
      let browser;
      try {
        browser = await playwright[name].launch({ headless: t.options.headless });
      } catch (err) {
        missing.push(name);
        continue;
      }
      try {
        const page = await browser.newPage({ viewport });
        const r = await measure(page, t.url);
        await page.screenshot({ path: path.join(t.dir, "shots", `cross-browser-${name}.png`) }).catch(() => {});
        const extraErrors = r.errors.filter((e) => !base.errors.includes(e));
        const extraFailed = r.failed.filter((f) => !base.failed.includes(f));
        const ratio = base.layout && r.layout ? r.layout.visibleElements / Math.max(1, base.layout.visibleElements) : 1;
        const textRatio = base.layout && r.layout ? r.layout.textLines / Math.max(1, base.layout.textLines) : 1;
        const label = name === "webkit" ? "Safari (WebKit)" : name[0].toUpperCase() + name.slice(1);

        checks.push(
          check(`Page loads in ${label}`, !r.loadError && (r.status ?? 0) < 400, {
            expected: `HTTP ${base.status}`,
            actual: r.loadError || `HTTP ${r.status}`,
            severity: "high",
            issue: `Page does not load in ${label}`,
          }),
          check(`No ${label}-only JavaScript errors`, extraErrors.length === 0, {
            expected: "same errors as Chrome (none extra)",
            actual: extraErrors.slice(0, 2).join(" | ") || "none",
            severity: "medium",
            issue: `JavaScript error only in ${label}: ${extraErrors[0]?.slice(0, 80)}`,
          }),
          check(`No ${label}-only failed requests`, extraFailed.length === 0, {
            expected: "same requests succeed",
            actual: extraFailed.slice(0, 3).join("; ") || "none",
            severity: "medium",
            issue: `Requests fail only in ${label}`,
          }),
          check(`Content matches Chrome in ${label}`, ratio > 0.75 && textRatio > 0.75, {
            expected: "≥ 75% of Chrome's visible elements and text",
            actual: `${Math.round(ratio * 100)}% of elements, ${Math.round(textRatio * 100)}% of text lines`,
            severity: "medium",
            issue: `Parts of the page are missing in ${label}`,
          }),
          check(`No sideways scrolling in ${label}`, !r.layout || r.layout.overflow <= Math.max(2, base.layout?.overflow ?? 0), {
            expected: "fits the window like in Chrome",
            actual: r.layout ? `${r.layout.overflow}px overflow` : "n/a",
            severity: "low",
            issue: `Layout overflows sideways in ${label}`,
          }),
        );
      } finally {
        await browser.close();
      }
    }

    if (!checks.length) {
      return { skipped: `Browsers not installed: ${missing.join(", ")}. Run: npx playwright install ${missing.join(" ")}` };
    }
    if (missing.length) {
      checks.push(
        check(`Browsers available (${missing.join(", ")} missing)`, false, {
          expected: "all requested browsers installed",
          actual: `run: npx playwright install ${missing.join(" ")}`,
          severity: "low",
          soft: true,
        }),
      );
    }
    return { primary: null, persistsOnReload: null, checks };
  },
};
