import crypto from "crypto";
import fs from "fs";
import path from "path";

// Reads saved scan results from disk and turns them into dashboard bug rows:
//   artifacts/scans/<scanId>/report.json   crawler (Scan page)
//   artifacts/tests/<runId>/bugops.json     test library (dashboard Re-Scan)
// Which runs belong to which user is recorded in MongoDB (userScans.js).

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const SAFE_ID = /^(scan|tests)-[\w-]+$/;

// "https://www.Site.com/page/#x" and "www.site.com/page" are the same target.
export function targetKey(url) {
  return String(url || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export const crawlReport = (scanId) =>
  SAFE_ID.test(scanId || "") ? readJson(path.join("artifacts", "scans", scanId, "report.json")) : null;
export const testsBugops = (runId) =>
  SAFE_ID.test(runId || "") ? readJson(path.join("artifacts", "tests", runId, "bugops.json")) : null;

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + u.hash || "/";
  } catch {
    return url || "/";
  }
};

// Stable per bug, so a status the user sets survives re-renders and reloads.
const bugKey = (...parts) => crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);

// A crawler bug → a dashboard row.
function crawlRow(bug, report, scanId) {
  // Where the error actually happened (the page it was logged on), else the
  // page the action started from.
  const where = bug.signals?.find((s) => s.at)?.at || bug.url;
  const evidence = (bug.signals || [])
    .slice(0, 3)
    .map((s) => `${s.type}: ${s.message || `${s.status || ""} ${s.url || ""}`.trim()}`)
    .join("; ");
  const rca = [
    bug.description && `What happened: ${bug.description}`,
    bug.rca && `Likely cause: ${bug.rca}`,
    `Found after: ${bug.action} on ${bug.url}.`,
    evidence && `Evidence: ${evidence}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    key: bugKey("crawl", report.startUrl, bug.title, where),
    source: "crawl",
    runId: scanId,
    title: bug.title,
    page: pathOf(where),
    url: where,
    detected: report.finishedAt,
    severity: SEVERITY_RANK[bug.severity] !== undefined ? bug.severity : "low",
    status: "open",
    rca,
    fix: bug.suggested_fix || "",
    screenshot: bug.screenshot || null,
  };
}

// Rows for one target from one crawl and/or one test run, merged.
export function bugopsFromRuns({ url, crawlId, testsId }) {
  const crawl = crawlId ? crawlReport(crawlId) : null;
  const tests = testsId ? testsBugops(testsId) : null;

  const rows = [
    ...(crawl ? crawl.bugs.map((b) => crawlRow(b, crawl, crawlId)) : []),
    ...(tests
      ? tests.rows.map((r) => ({
          ...r,
          key: r.key || bugKey("tests", tests.url, r.title, r.page),
          source: "tests",
          runId: testsId,
        }))
      : []),
  ];
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.title.toLowerCase()}|${r.page}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || new Date(b.detected) - new Date(a.detected));
  unique.forEach((r, i) => (r.id = i + 1));

  const dates = [crawl?.finishedAt, tests?.finishedAt].filter(Boolean);
  return {
    url: url || crawl?.startUrl || tests?.url || null,
    lastScanned: dates.sort().at(-1) || null,
    sources: { crawl: crawl ? crawlId : null, tests: tests ? testsId : null },
    rows: unique,
  };
}

export function countBugs(rows) {
  return {
    total: rows.length,
    high: rows.filter((r) => r.severity === "high").length,
    medium: rows.filter((r) => r.severity === "medium").length,
    low: rows.filter((r) => r.severity === "low").length,
  };
}
