import fs from "fs";
import path from "path";
import { crawlReport } from "../history.js";

// Collects what BugOps actually recorded about one dashboard bug row, from the
// run's own artifacts, for the GitHub issue. Nothing is guessed: fields that
// weren't recorded are left out, and AI analysis is kept apart from what was
// observed so the issue can label it as suspected.

const SAFE_RUN = /^(scan|tests)-[\w-]+$/;
const SAFE_PAGE_RUN = /^tests-[\w-]+\/page-\d{2}$/;
const ARTIFACTS = () => path.resolve("artifacts");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// File name only: local paths never leave the server.
const fileName = (p) => (typeof p === "string" && p ? path.basename(p) : null);
const unique = (list) => [...new Set(list.filter(Boolean))];
// The quoted label in 'Click "Add item"' or 'button "Add item"'.
const quoted = (s) => /"([^"]{1,120})"/.exec(String(s || ""))?.[1] || null;

// A screenshot path from a run's own records, accepted only if it is a PNG
// inside artifacts/ that exists (never a path from the browser).
export function safeScreenshotPath(p) {
  if (typeof p !== "string" || !p.toLowerCase().endsWith(".png")) return null;
  const abs = path.resolve(p);
  if (!abs.startsWith(ARTIFACTS() + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

// "POST http://x/api/items → 500" (describeCall format) → { method, url, status }
function parseCall(line) {
  const m = /^([A-Z]+) (\S+) → (\d{3})$/.exec(String(line || ""));
  return m ? { method: m[1], url: m[2], status: Number(m[3]) } : null;
}

function crawlEvidence(row) {
  const report = SAFE_RUN.test(row.runId || "") ? crawlReport(row.runId) : null;
  const bugs = report?.bugs || [];
  const bug =
    bugs.find((b) => b.title === row.title && (b.screenshot || null) === (row.screenshot || null)) ||
    bugs.find((b) => b.title === row.title) ||
    null;
  const action = bug?.screenshot ? (report.actions || []).find((a) => a.screenshot === bug.screenshot) : null;
  const loggedIn = !!report && fs.existsSync(path.join("artifacts", "scans", row.runId, "after-login.png"));

  const steps = [];
  if (report?.startUrl) steps.push(`Open ${report.startUrl}${loggedIn ? " and log in (the scan used a test account)" : ""}.`);
  if (action) {
    if (action.urlBefore && action.urlBefore !== report.startUrl) steps.push(`Go to ${action.urlBefore}.`);
    steps.push(`${action.label}.`);
  } else if (bug?.action) {
    steps.push(`On ${bug.url}: ${bug.action}.`);
  }

  const signals = bug?.signals || [];
  const errors = signals.slice(0, 10).map((s) => {
    const what = s.type === "http_error" ? `HTTP ${s.status} from ${s.url}` : s.url ? `${s.message || ""} (${s.url})`.trim() : s.message;
    return `${s.type}: ${what}${s.at ? ` [on ${s.at}]` : ""}`;
  });
  const shot = bug?.screenshot || row.screenshot;

  return {
    summary: bug?.description || row.title,
    summaryBasis: bug?.description ? "AI evaluation of the screenshot and browser signals" : null,
    foundBy: "BugOps crawler (AI-guided exploration)",
    steps,
    expected: action?.expected ? { text: action.expected, basis: "what the testing agent predicted before acting" } : null,
    actual: unique([
      action?.summary,
      action?.outcome && `Outcome recorded: ${action.outcome}.`,
      action?.error && `Action error: ${action.error}`,
    ]),
    errors,
    stacks: signals.filter((s) => s.stack).slice(0, 5).map((s) => ({ message: `${s.type}: ${s.message || ""}`.trim(), stack: s.stack })),
    failedRequests: signals.filter((s) => s.type === "http_error").map((s) => ({ method: null, url: s.url, status: s.status })),
    elementText: quoted(action?.label || bug?.action),
    failedChecks: [],
    rootCause: bug?.rca || null,
    fix: bug?.suggested_fix || row.fix || null,
    fixBasis: "AI suggestion",
    screenshot: fileName(shot),
    screenshotPath: safeScreenshotPath(shot),
  };
}

// The test case behind a test-library row: testcases.json of the single page
// run, or of the matching page in a site run.
function findTest(row) {
  if (!SAFE_RUN.test(row.runId || "")) return null;
  const dir = path.join("artifacts", "tests", row.runId);
  const files = [path.join(dir, "testcases.json")];
  for (const p of readJson(path.join(dir, "site.json"))?.pages || []) {
    if (SAFE_PAGE_RUN.test(p.runId || "")) files.push(path.join("artifacts", "tests", ...p.runId.split("/"), "testcases.json"));
  }
  for (const file of files) {
    const run = readJson(file);
    if (!run || (row.url && run.url !== row.url)) continue;
    const test = (run.tests || []).find((t) => t.id === row.testId);
    if (test) return test;
  }
  return null;
}

function testsEvidence(row) {
  const test = findTest(row);
  const failedChecks = row.evidence?.failedChecks || [];
  const testSteps = test?.evidence?.steps || [];
  const steps = testSteps.map((s) => `${s.label}.`);
  const errors = unique(
    testSteps.flatMap((s) => [
      ...(s.console || []),
      ...(s.network || []).filter((n) => /→\s*[45]\d\d|failed/i.test(n)),
      s.error && `Step error: ${s.error}`,
    ]),
  ).slice(0, 10);
  const stacks = testSteps
    .flatMap((s) => s.stacks || [])
    .slice(0, 5)
    .map((s) => {
      const [message, ...rest] = String(s).split("\n");
      return { message, stack: rest.join("\n") };
    });
  const failedRequests = testSteps.flatMap((s) => (s.network || []).map(parseCall)).filter((r) => r && r.status >= 400);
  const shot = row.evidence?.screenshot;

  return {
    summary: failedChecks.length
      ? `Automated test "${test?.name || row.template}" failed ${failedChecks.length} check(s) on ${row.element || "the page"}.`
      : row.title,
    summaryBasis: null,
    foundBy: `BugOps test library (template \`${row.template}\`${row.element ? ` on ${row.element}` : ""})`,
    steps: steps.length ? [`Open ${row.url}.`, ...steps] : [],
    expected: test?.spec?.expectedStateChange ? { text: test.spec.expectedStateChange, basis: "the test's specification" } : null,
    actual: [],
    errors,
    stacks,
    failedRequests,
    elementText: quoted(row.element),
    failedChecks,
    rootCause: null,
    fix: row.fix || null,
    fixBasis: row.fixSource === "llm" ? "AI suggestion based on the test evidence" : "generic hint for this kind of test",
    screenshot: fileName(shot),
    screenshotPath: safeScreenshotPath(shot),
  };
}

export function gatherEvidence(row) {
  const details = row.source === "crawl" ? crawlEvidence(row) : testsEvidence(row);
  return {
    title: row.title,
    severity: row.severity,
    pageUrl: row.url,
    detected: row.detected,
    runId: row.runId,
    ...details,
  };
}

// Enough to be a useful issue: a title, a page, and at least one concrete observation.
export function hasEnoughDetail(ev) {
  return !!(ev.title && ev.pageUrl && (ev.steps.length || ev.errors.length || ev.failedChecks.length || ev.actual.length || ev.summaryBasis));
}
