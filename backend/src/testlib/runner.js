import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { extractFullPageInfo } from "../pageAnalyzer.js";
import { attachObserver, captureState, describeCall, summarizeDiff } from "./observer.js";
import { categorizeElements } from "./categorizer.js";
import { describeElement, elementLabel, elementSignature, extractElements } from "./elements.js";
import { TestContext, settle } from "./context.js";
import { ALL_TEMPLATES, ELEMENT_TEMPLATES, PAGE_TEMPLATES } from "./templates/index.js";
import { judgeOutcome } from "./templates/llmJudge.js";
import { addLlmFixes, toBugOpsRows } from "./bugops.js";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const firstLine = (msg) => String(msg).split("\n")[0].slice(0, 200);

export function defaultOptions() {
  const user = process.env.TEST_USERNAME;
  const pass = process.env.TEST_PASSWORD;
  return {
    useLlm: !!process.env.GEMINI_API_KEY,
    headless: process.env.CRAWL_HEADLESS !== "false",
    // Stateful tests (create/delete/cart) write real data: opt-in only.
    allowMutations: process.env.TESTS_ALLOW_MUTATIONS === "true",
    credentials: user && pass ? { username: user, password: pass } : null,
    maxElementTests: Number(process.env.TESTS_MAX_ELEMENT_TESTS) || 25,
    maxPerTemplate: 6,
    maxLinks: 8,
    // Links the link-checker requests (no clicks).
    maxLinkChecks: Number(process.env.TESTS_MAX_LINK_CHECKS) || 40,
    searchTerm: "test",
    // Clicks on menus/toggles to find elements that only appear afterwards.
    maxDiscoveryClicks: 5,
    // LLM reviews of passing results (judge: true templates).
    maxJudgeCalls: Number(process.env.TESTS_MAX_JUDGE_CALLS) || 5,
    // Other browsers for the cross-browser test (Playwright builds).
    browsers: (process.env.TESTS_BROWSERS || "firefox,webkit").split(",").map((b) => b.trim()).filter(Boolean),
    // Pages per site run (the start page + same-site links found on it).
    maxPages: Number(process.env.TESTS_MAX_PAGES) || 1,
  };
}

const REQUIREMENT_HINT = {
  mutations: "writes real data: run with --allow-mutations (or TESTS_ALLOW_MUTATIONS=true) on a test environment",
  credentials: "needs a test account: set TEST_USERNAME and TEST_PASSWORD",
};

function unmetRequirement(tpl, options) {
  if (tpl.requires.includes("mutations") && !options.allowMutations) return "mutations";
  if (tpl.requires.includes("credentials") && !options.credentials) return "credentials";
  return null;
}

// Picks which template runs on which element. Highest-priority elements
// first, destructive ones skipped and flagged, caps per template.
export function planTests(elements, options, ctx) {
  const planned = [];
  const skipped = [];
  const perTemplate = new Map();
  const reportedUnmet = new Set();
  let elementTests = 0;

  const requirementsMet = (tpl, el) => {
    const unmet = unmetRequirement(tpl, options);
    if (!unmet) return true;
    if (!reportedUnmet.has(tpl.id)) {
      reportedUnmet.add(tpl.id);
      skipped.push({ tpl, el, reason: `Not run: ${REQUIREMENT_HINT[unmet]}` });
    }
    return false;
  };

  for (const tpl of PAGE_TEMPLATES) planned.push({ tpl, el: null });

  // Repeated per-row controls ("Edit" on every row) are tested/reported once.
  const seenSignatures = new Set();
  const sorted = [...elements].sort((a, b) => b.priority - a.priority);
  for (const el of sorted) {
    const sig = `${el.frameUrl || ""}|${elementSignature(el)}`;
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    // Delete buttons, logout, purchase... are never clicked directly.
    // (update-item/delete-item act only on the item create-item made.)
    if (el.destructive) {
      skipped.push({
        tpl: null,
        el,
        reason: `Destructive action not clicked (${el.destructiveReason || "flagged by the LLM"})`,
        flagged: true,
      });
      continue;
    }
    for (const tpl of ELEMENT_TEMPLATES) {
      if (tpl.followUpOf) continue;
      if (!tpl.categories.includes(el.category) || !tpl.kinds.includes(el.kind)) continue;
      if (!tpl.appliesTo(el, ctx)) continue;
      if (!requirementsMet(tpl, el)) continue;
      const count = perTemplate.get(tpl.id) || 0;
      const cap = tpl.onePerPage ? 1 : tpl.id === "nav-link" ? options.maxLinks : options.maxPerTemplate;
      if (count >= cap || elementTests >= options.maxElementTests) continue;
      perTemplate.set(tpl.id, count + 1);
      elementTests++;
      planned.push({ tpl, el });
    }
  }

  // Follow-ups (update/delete after create): their controls may only exist
  // once the created item does, so they're planned with their parent.
  for (const { tpl: parent, el } of [...planned]) {
    for (const tpl of ELEMENT_TEMPLATES.filter((f) => f.followUpOf === parent.id)) {
      if (requirementsMet(tpl, el)) planned.push({ tpl, el });
    }
  }

  // Page tests first, follow-ups last (in their runLast order), then
  // priority, then template order.
  const order = new Map(ALL_TEMPLATES.map((t, i) => [t.id, i]));
  planned.sort((a, b) => {
    if (!a.el !== !b.el) return a.el ? 1 : -1;
    const last = (a.tpl.runLast || 0) - (b.tpl.runLast || 0);
    if (last) return last;
    return (b.el?.priority ?? 0) - (a.el?.priority ?? 0) || order.get(a.tpl.id) - order.get(b.tpl.id);
  });
  return { planned, skipped };
}

function compactStep(obs) {
  return {
    step: obs.step,
    label: obs.label,
    urlBefore: obs.urlBefore,
    urlAfter: obs.urlAfter,
    error: obs.error,
    stateChange: summarizeDiff(obs.diff),
    network: obs.network.slice(0, 15).map(describeCall),
    console: obs.console.slice(0, 10).map((c) => `${c.type}: ${c.text}`),
    blocked: obs.blocked.map(describeCall),
    screenshot: obs.screenshot,
    dom: obs.dom,
  };
}

function elementInfo(el) {
  if (!el) return null;
  return {
    ...describeElement(el),
    label: elementLabel(el),
    category: el.category,
    priority: el.priority,
    categorySource: el.source,
    reason: el.reason,
  };
}

async function executeTest(t, tpl, el) {
  const id = `${tpl.id}:${el ? el.id : "page"}`;
  // Elements found by discovery are reached by replaying their opener click.
  t.begin(id, el?.via || []);
  const started = Date.now();
  let out;
  let error = null;
  try {
    out = await tpl.run(t, el);
  } catch (err) {
    error = err.message.split("\n")[0].slice(0, 300);
  }

  const base = {
    id,
    template: tpl.id,
    name: tpl.name,
    category: el?.category ?? "page",
    element: elementInfo(el),
    spec: tpl.spec,
  };
  const evidence = { steps: t.actions.map(compactStep) };
  const durationMs = Date.now() - started;

  if (error) return { ...base, status: "error", severity: null, error, checks: [], observed: null, evidence, durationMs };
  if (out.skipped) return { ...base, status: "skipped", severity: null, skipReason: out.skipped, checks: [], observed: null, evidence, durationMs };

  const failed = out.checks.filter((c) => !c.pass && !c.soft);
  for (const c of out.checks) c.severity = c.severity || tpl.severity;
  const severity = failed.length
    ? failed.map((c) => c.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0]
    : null;
  const p = out.primary;

  return {
    ...base,
    status: failed.length ? "fail" : "pass",
    severity,
    checks: out.checks,
    // The template schema, filled in with what actually happened.
    observed: p && {
      action: p.label,
      network: p.network.slice(0, 10).map(describeCall),
      stateChange: summarizeDiff(p.diff),
      console: p.console.filter((c) => c.type !== "warning").slice(0, 5).map((c) => c.text.slice(0, 200)),
      persistsOnReload: out.persistsOnReload ?? null,
    },
    evidence,
    durationMs,
  };
}

// Elements that only appear after an interaction (menu items, modal forms,
// accordion content): click the most promising openers and keep whatever is
// new. Each found element remembers its opener in `via`, which fresh()
// replays before every test on it.
async function discoverElements(t, elements, options) {
  const openers = elements
    // Not edit/delete buttons: what they reveal (an editor for EXISTING data)
    // must not be tested; update-item handles editing on its own item.
    .filter((el) => el.kind === "button" && !el.destructive && !["cart", "auth", "delete", "update"].includes(el.category))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, options.maxDiscoveryClicks);
  const known = new Set(elements.map(elementSignature));
  const found = [];
  let nextId = elements.length;
  for (const opener of openers) {
    t.begin(`discovery:${opener.id}`);
    try {
      await t.fresh();
      const obs = await t.act(`Discovery: click ${elementLabel(opener)} to reveal hidden elements`, async () =>
        (await t.locate(opener)).click({ timeout: 5000 }),
      );
      // Navigating to another page isn't "revealing" anything on this one.
      const samePage = (a, b) => {
        const x = new URL(a);
        const y = new URL(b);
        return x.origin === y.origin && x.pathname === y.pathname;
      };
      if (obs.error || !samePage(obs.urlBefore, obs.urlAfter) || !obs.diff.dom.changed) continue;
      const { elements: after } = await extractElements(t.page);
      for (const el of after) {
        const sig = elementSignature(el);
        if (known.has(sig)) continue;
        known.add(sig);
        found.push({ ...el, id: `e${nextId++}`, via: [opener] });
      }
    } catch {}
  }
  return found;
}

// LLM review of passing results from `judge: true` templates.
async function judgeResults(tests, templates, options, { emit, onLlmCall }) {
  let budget = options.maxJudgeCalls;
  for (const test of tests) {
    if (budget <= 0) break;
    if (test.status !== "pass" || !templates.get(test.template)?.judge) continue;
    const shot = test.evidence.steps.find((s) => s.label === test.observed?.action)?.screenshot;
    if (!shot || !fs.existsSync(shot)) continue;
    budget--;
    try {
      onLlmCall();
      const c = await judgeOutcome(test, fs.readFileSync(shot));
      if (!c) continue;
      test.checks.push(c);
      if (!c.pass && !c.soft) {
        test.status = "fail";
        test.severity = c.severity;
      }
    } catch (err) {
      emit("warning", `LLM review failed: ${firstLine(err.message)}`);
      return;
    }
  }
}

function summarize(tests) {
  const count = (s) => tests.filter((t) => t.status === s).length;
  const failed = tests.filter((t) => t.status === "fail");
  return {
    total: tests.length,
    pass: count("pass"),
    fail: failed.length,
    skipped: count("skipped"),
    error: count("error"),
    bySeverity: {
      high: failed.filter((t) => t.severity === "high").length,
      medium: failed.filter((t) => t.severity === "medium").length,
      low: failed.filter((t) => t.severity === "low").length,
    },
  };
}

// Runs the whole library on one page:
//   observe → categorize (LLM) → plan → run templates → BugOps rows.
// Writes everything to artifacts/tests/<runId>/ and returns the result.
export async function runSuite(url, opts = {}) {
  const options = { ...defaultOptions(), ...opts };
  const onEvent = options.onEvent || (() => {});
  const emit = (type, message) => onEvent({ at: new Date().toISOString(), type, message });
  const runId = options.runId || `tests-${Date.now()}`;
  const dir = path.join("artifacts", "tests", runId);
  fs.mkdirSync(path.join(dir, "dom"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  const startedAt = new Date().toISOString();
  let llmCalls = 0;

  const browser = await chromium.launch({ channel: "chrome", headless: options.headless });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // Links that open new tabs: the suite stays in one tab. Only pages opened
    // BY a page are closed; tabs a template opens itself are left alone.
    context.on("page", async (popup) => {
      if (await popup.opener().catch(() => null)) popup.close().catch(() => {});
    });
    const observer = await attachObserver(page, { origin: new URL(url).origin });

    // 1. Observe the landing page: page-info.json (+ network, console,
    //    cookies, storage, DOM) and the screenshot.
    emit("observe", `Opening ${url}`);
    const mark = observer.mark();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page);
    if (res && res.status() >= 400) throw new Error(`Page returned HTTP ${res.status()}`);
    const finalUrl = page.url();
    const state = await captureState(page);
    const pageInfo = await extractFullPageInfo(page, { observed: observer.since(mark), state });
    fs.writeFileSync(path.join(dir, "page-info.json"), JSON.stringify(pageInfo, null, 2));
    fs.writeFileSync(path.join(dir, "dom", "landing.html"), state.html);
    const screenshot = await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true });

    // 2. Screenshot + elements → LLM → category and priority per element.
    const { title, elements } = await extractElements(page);
    emit("categorize", `Categorizing ${elements.length} elements${options.useLlm ? " with the LLM" : " with keyword rules"}`);
    const categorized = await categorizeElements({
      screenshot,
      url: finalUrl,
      title,
      elements,
      useLlm: options.useLlm,
      onLlmCall: () => llmCalls++,
    });
    // A broken key/quota fails every call the same way: stop using the LLM.
    const llmOk = options.useLlm && !(categorized.llmError && !categorized.llmUsed);
    if (categorized.llmError) emit("warning", `LLM categorizer: ${firstLine(categorized.llmError)} (rules used instead)`);

    const t = new TestContext({ page, observer, url: finalUrl, dir, options });

    // 2b. Elements that only appear after clicking something.
    let allElements = categorized.elements;
    const discovered = await discoverElements(t, allElements, options);
    if (discovered.length) {
      emit("discover", `Found ${discovered.length} element(s) that appear after clicking menus/toggles`);
      const more = await categorizeElements({
        screenshot: null,
        url: finalUrl,
        title,
        elements: discovered,
        useLlm: llmOk,
        onLlmCall: () => llmCalls++,
      });
      allElements = [...allElements, ...more.elements];
    }

    fs.writeFileSync(
      path.join(dir, "categorized.json"),
      JSON.stringify(
        {
          pageType: categorized.pageType,
          llmUsed: categorized.llmUsed,
          llmError: categorized.llmError,
          elements: allElements.map((el) => ({ ...elementInfo(el), destructive: el.destructive, destructiveReason: el.destructiveReason })),
        },
        null,
        2,
      ),
    );

    // 3 + 4. Plan and run the templates. Every action is observed and logged.
    const { planned, skipped } = planTests(allElements, options, t);
    emit("plan", `${planned.length} tests planned, ${skipped.length} skipped`);

    const tests = [];
    for (const [i, { tpl, el }] of planned.entries()) {
      emit("test", `[${i + 1}/${planned.length}] ${tpl.name} — ${elementLabel(el)}`);
      const result = await executeTest(t, tpl, el);
      tests.push(result);
      const failedNames = result.checks.filter((c) => !c.pass && !c.soft).map((c) => c.name).join(", ");
      emit(result.status, `${result.status.toUpperCase()}${result.severity ? ` (${result.severity})` : ""}: ${tpl.id} ${elementLabel(el)}${failedNames ? ` — ${failedNames}` : ""}${result.error ? ` — ${result.error}` : ""}${result.skipReason ? ` — ${result.skipReason}` : ""}`);
    }
    for (const s of skipped) {
      tests.push({
        id: `${s.tpl?.id || "safety"}:${s.el.id}`,
        template: s.tpl?.id || "safety",
        name: s.tpl?.name || "Destructive element (not clicked)",
        category: s.el.category,
        element: elementInfo(s.el),
        spec: s.tpl?.spec || null,
        status: "skipped",
        severity: null,
        skipReason: s.reason,
        flaggedDestructive: !!s.flagged,
        checks: [],
        observed: null,
        evidence: { steps: [] },
      });
    }

    fs.writeFileSync(
      path.join(dir, "exploration.json"),
      JSON.stringify(
        {
          actions: t.exploration,
          notClicked: skipped.filter((s) => s.flagged).map((s) => ({ element: elementLabel(s.el), reason: s.reason })),
        },
        null,
        2,
      ),
    );

    const templates = new Map(ALL_TEMPLATES.map((tpl) => [tpl.id, tpl]));
    if (llmOk) {
      emit("judge", "Asking the LLM to review passing results for logic errors");
      await judgeResults(tests, templates, options, { emit, onLlmCall: () => llmCalls++ });
    }

    // 5. Failed checks → BugOps rows (fix suggestions from the LLM).
    const bugops = toBugOpsRows(tests, { url: finalUrl, templates });
    if (llmOk && bugops.length) {
      emit("fixes", `Asking the LLM for fix suggestions for ${bugops.length} issues`);
      const fixes = await addLlmFixes(bugops, { onLlmCall: () => llmCalls++ });
      if (fixes.error) emit("warning", `LLM fixes failed: ${firstLine(fixes.error)} (template hints used)`);
    }

    const { credentials, onEvent: _onEvent, ...safeOptions } = options;
    const result = {
      runId,
      url: finalUrl,
      requestedUrl: url,
      title,
      pageType: categorized.pageType,
      startedAt,
      finishedAt: new Date().toISOString(),
      options: { ...safeOptions, credentials: credentials ? "provided" : null },
      llm: { categorizer: categorized.llmUsed, calls: llmCalls },
      summary: summarize(tests),
      tests,
      // Same-site links found here, most important first (for site runs).
      links: allElements
        .filter((el) => el.kind === "link" && el.href && !el.destructive && t.sameSite(el.href) && !el.frameUrl)
        .sort((a, b) => b.priority - a.priority)
        .map((el) => el.href),
    };
    fs.writeFileSync(path.join(dir, "testcases.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(dir, "bugops.json"), JSON.stringify({ runId, url: finalUrl, finishedAt: result.finishedAt, rows: bugops }, null, 2));
    emit("done", `Done: ${result.summary.pass} passed, ${result.summary.fail} failed, ${result.summary.skipped} skipped`);
    return { ...result, dir, bugops };
  } finally {
    await browser.close();
  }
}

const pageKey = (u) => {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/$/, "") + x.hash.replace(/^#\/?$/, "");
  } catch {
    return u;
  }
};

// Runs the library on several pages of one site: the start page, then the
// same-site links found there (highest priority first), up to maxPages.
// Writes one combined bugops.json so the dashboard shows the whole site.
export async function runSite(url, opts = {}) {
  const options = { ...defaultOptions(), ...opts };
  if (options.maxPages <= 1) return runSuite(url, opts);
  const emit = (type, message) => options.onEvent?.({ at: new Date().toISOString(), type, message });
  const siteId = options.runId || `tests-${Date.now()}`;
  const dir = path.join("artifacts", "tests", siteId);
  const pageRunId = (n) => `${siteId}/page-${String(n).padStart(2, "0")}`;

  emit("site", `Page 1/${options.maxPages}: ${url}`);
  const pages = [await runSuite(url, { ...opts, runId: pageRunId(1) })];
  const seen = new Set([pageKey(url), pageKey(pages[0].url)]);
  const failedPages = [];

  for (const link of pages[0].links) {
    if (pages.length >= options.maxPages) break;
    if (seen.has(pageKey(link))) continue;
    seen.add(pageKey(link));
    emit("site", `Page ${pages.length + 1}/${options.maxPages}: ${link}`);
    try {
      pages.push(await runSuite(link, { ...opts, runId: pageRunId(pages.length + 1) }));
    } catch (err) {
      failedPages.push({ url: link, error: firstLine(err.message) });
      emit("warning", `Could not test ${link}: ${firstLine(err.message)}`);
    }
  }

  const bugops = pages
    .flatMap((p) => p.bugops)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((row, i) => ({ ...row, id: i + 1 }));
  const finishedAt = new Date().toISOString();
  const summary = summarize(pages.flatMap((p) => p.tests));
  const site = {
    runId: siteId,
    url: pages[0].url,
    finishedAt,
    summary,
    pages: pages.map((p) => ({ url: p.url, runId: p.runId, summary: p.summary, dir: p.dir })),
    failedPages,
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(site, null, 2));
  fs.writeFileSync(path.join(dir, "bugops.json"), JSON.stringify({ runId: siteId, url: pages[0].url, finishedAt, rows: bugops }, null, 2));
  emit("done", `Site done: ${pages.length} page(s), ${summary.pass} passed, ${summary.fail} failed`);
  return { ...site, dir, bugops, tests: pages.flatMap((p) => p.tests) };
}
