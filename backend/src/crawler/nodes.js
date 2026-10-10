import fs from "fs";
import path from "path";
import { interrupt } from "@langchain/langgraph";
import { analyzePage } from "../llm/gemini.js";
import { extractPageInfo } from "../pageAnalyzer.js";
import { getCrawlLimits } from "./config.js";
import { extractCandidates, fingerprint, locateClickable, locateField, normalizeUrl } from "./dom.js";
import { rankActions, evaluateAction } from "./llm.js";
import { isRiskyByKeyword, testValueFor } from "./safety.js";
import { activeMs, emit, getSession, openBrowser } from "./session.js";

const limits = getCrawlLimits();

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function screenshot(session, name) {
  const file = path.join(session.dir, `${name}.png`);
  const buffer = await session.page.screenshot({ path: file });
  return { file, buffer };
}

function canUseLlm(session) {
  return !session.llmDisabled && session.llmCalls < limits.maxLlmCalls;
}

// After a daily-quota error, stop calling the LLM for the rest of the scan
// (the crawl continues with rule-based ranking and signal-only bug reports).
function noteLlmError(session, err) {
  if (err.code === "QUOTA_EXHAUSTED" && !session.llmDisabled) {
    session.llmDisabled = true;
    emit(session, "warning", "LLM quota exhausted: continuing without the LLM for this scan");
  }
}

function actionLabel(action) {
  if (action.kind === "visit") return `Visit "${action.target.text || action.target.href}"`;
  if (action.kind === "click") return `Click "${action.target.text || action.target.ariaLabel || action.target.tag}"`;
  if (action.kind === "toggle") return `Toggle "${action.target.text}"`;
  const names = action.target.fields.map((f) => f.label || f.placeholder || f.name || f.type).join(", ");
  return `Form [${names}]`;
}

// Performs one action on the live page. Also used to replay the path that
// leads to a screen which has no URL of its own (single-page apps).
async function performAction(page, action, decision) {
  if (action.kind === "visit") {
    const res = await page.goto(action.target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { httpStatus: res?.status() ?? null };
  }

  if (action.kind === "toggle") {
    await locateField(page, action.target).click({ timeout: 5000 });
    return {};
  }

  if (action.kind === "click") {
    const target = await locateClickable(page, action.target);
    await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await target.click({ timeout: 5000 });
    return {};
  }

  // Form: fill every field with obviously fake data, submit only if approved.
  let lastFilled = null;
  for (const field of action.target.fields) {
    const plan = testValueFor(field);
    const locator = locateField(page, field);
    if (plan.kind === "fill") {
      await locator.fill(plan.value, { timeout: 5000 });
      lastFilled = locator;
    } else if (plan.kind === "check") {
      await locator.check({ timeout: 5000 }).catch(() => {});
    } else if (plan.kind === "select") {
      const options = await locator.locator("option").count();
      if (options > 1) await locator.selectOption({ index: 1 }, { timeout: 5000 });
    }
  }
  if (decision === "fill_submit") {
    if (action.target.submitDomIndex !== null) {
      const submit = await locateClickable(page, {
        domIndex: action.target.submitDomIndex,
        role: "button",
        text: action.target.submitText,
      });
      await submit.click({ timeout: 5000 });
    } else if (lastFilled) {
      await lastFilled.press("Enter");
    }
  }
  return {};
}

// Stop conditions, checked before every action. Returns a reason or null.
function budgetExceeded(state, session) {
  if (session.stopRequested) return "stopped_by_user";
  if (activeMs(session) >= limits.timeLimitMs) return "time_limit";
  if (state.counters.actions >= limits.maxActions) return "max_actions";
  if (Object.keys(state.states).length >= limits.maxStates) return "max_states";
  if (state.counters.noNovelty >= limits.noNoveltyLimit) return "no_new_screens";
  return null;
}

// ---------------------------------------------------------------- nodes

// init: open Chrome and load the landing page.
export async function initNode(state) {
  const session = getSession(state.scanId);
  emit(session, "start", `Opening ${state.startUrl}`);
  await openBrowser(session);
  const res = await session.page.goto(state.startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await settle(session.page);
  if (res && res.status() >= 400) {
    throw new Error(`Landing page returned HTTP ${res.status()}`);
  }

  const snapshot = await extractCandidates(session.page);
  const id = fingerprint(snapshot);
  const shot = await screenshot(session, "landing");
  session.signals = [];

  return {
    origin: new URL(session.page.url()).origin,
    currentStateId: id,
    states: {
      [id]: {
        id,
        url: session.page.url(),
        title: snapshot.title,
        path: [],
        depth: 0,
        explorable: true,
        screenshot: shot.file,
      },
    },
  };
}

// observe: read the current screen. On the landing page this also runs the
// full page analysis (the original single-page prompt).
export async function observeNode(state) {
  const session = getSession(state.scanId);
  const page = session.page;
  const snapshot = await extractCandidates(page);
  const current = state.states[state.currentStateId];
  emit(session, "observe", `Observing ${current.url} (depth ${current.depth})`, {
    url: current.url,
    clickables: snapshot.clickables.length,
    forms: snapshot.forms.length,
  });

  const update = { currentSnapshot: snapshot };

  if (current.depth === 0 && !state.landing) {
    emit(session, "landing", "Analyzing landing page");
    try {
      const pageInfo = await extractPageInfo(page);
      const buffer = await page.screenshot({ fullPage: true });
      session.llmCalls++;
      const result = await analyzePage(buffer, pageInfo);
      fs.writeFileSync(path.join(session.dir, "page-info.json"), JSON.stringify(pageInfo, null, 2));
      fs.writeFileSync(
        path.join(session.dir, "landing-analysis.json"),
        JSON.stringify(result.parsed || result.output_text, null, 2),
      );
      update.landing = result.parsed || { error: "LLM reply was not valid JSON", raw: result.output_text };
    } catch (err) {
      noteLlmError(session, err);
      emit(session, "warning", `Landing analysis failed: ${err.message}`);
      update.landing = { error: err.message };
    }
  }
  return update;
}

// plan: turn the screen's elements into candidate actions, have the LLM rank
// them and flag risky ones, and add them to the frontier (the to-do list).
export async function planNode(state) {
  const session = getSession(state.scanId);
  const current = state.states[state.currentStateId];
  const snapshot = state.currentSnapshot;
  const known = new Set([...state.triedKeys, ...state.frontier.map((a) => a.key)]);
  const pathname = new URL(current.url).pathname;
  const fresh = [];

  const add = (action) => {
    if (known.has(action.key)) return;
    known.add(action.key);
    fresh.push(action);
  };

  for (const c of snapshot.clickables) {
    if (c.inForm) continue;
    const label = c.text || c.ariaLabel || "";
    let href = null;
    try {
      href = c.href ? new URL(c.href) : null;
    } catch {}
    // Links that are really buttons: href="#" or javascript:.
    const scriptLink = !!href && (href.protocol === "javascript:" || c.href.endsWith("#"));
    const realLink = !scriptLink && href && (href.protocol === "http:" || href.protocol === "https:");

    if (realLink) {
      const target = normalizeUrl(href.toString());
      // Only crawl the site under test; links back to this same screen add nothing.
      if (href.origin !== state.origin || target === normalizeUrl(current.url)) continue;
      add({ key: `visit:${target}`, kind: "visit", target: c });
    } else if (!href || scriptLink) {
      const key = label ? `click:${c.role}:${label}` : `click:${pathname}:${c.domIndex}`;
      add({ key, kind: "click", target: c });
    }
  }
  snapshot.forms.forEach((form) => {
    const only = form.fields[0];
    // A lone checkbox/radio outside a <form> is a toggle, not a form to fill.
    if (form.formIndex === null && (only.type === "checkbox" || only.type === "radio")) {
      const label = only.label || only.name || `${only.type} ${only.domIndex}`;
      add({ key: `toggle:${pathname}:${label}`, kind: "toggle", target: { ...only, text: label } });
      return;
    }
    const sig = form.fields.map((f) => f.name || f.placeholder || f.label || f.type).join(",");
    add({ key: `form:${pathname}:${sig}`, kind: "form", target: form });
  });

  const candidates = fresh.map((a, i) => ({
    id: `a${i}`,
    kind: a.kind,
    label: actionLabel(a),
    href: a.target.href || null,
  }));

  let ranking = null;
  if (fresh.length && canUseLlm(session)) {
    try {
      const shot = await session.page.screenshot();
      session.llmCalls++;
      ranking = await rankActions({
        screenshot: shot,
        url: current.url,
        title: current.title,
        candidates,
        alreadyTried: state.actionsLog.map((l) => l.label),
      });
    } catch (err) {
      noteLlmError(session, err);
      emit(session, "warning", `LLM ranking failed, using default order: ${err.message}`);
    }
  }
  const byId = new Map((ranking || []).map((r) => [r.id, r]));
  const defaultPriority = { visit: 5, click: 4, toggle: 3, form: 3 };

  const planned = fresh.map((a, i) => {
    const r = byId.get(`a${i}`);
    const keywordRisk = isRiskyByKeyword(a.target);
    return {
      ...a,
      label: candidates[i].label,
      sourceStateId: current.id,
      depth: current.depth + 1,
      priority: Number(r?.priority) || defaultPriority[a.kind],
      reason: r?.reason || "",
      risky: keywordRisk || r?.risky === true,
      riskReason: r?.risk_reason || (keywordRisk ? "Label matches a destructive/side-effect keyword" : ""),
    };
  });

  const frontier = [...state.frontier, ...planned].sort(
    (x, y) => y.priority - x.priority || x.depth - y.depth,
  );
  emit(session, "plan", `Queued ${planned.length} new actions (${frontier.length} in queue)`, {
    ranked: !!ranking,
  });
  return { frontier, currentSnapshot: null };
}

// select: check the budget, then take the highest-priority untried action.
export async function selectNode(state) {
  const session = getSession(state.scanId);
  const stop = budgetExceeded(state, session);
  if (stop) return { stopReason: stop, pending: null };
  if (!state.frontier.length) return { stopReason: "nothing_left_to_explore", pending: null };

  const [next, ...rest] = state.frontier;
  return {
    pending: next,
    decision: null,
    frontier: rest,
    triedKeys: [...state.triedKeys, next.key],
  };
}

// approve: pause and ask the user before risky actions and before any form.
// interrupt() suspends the graph here; when the user answers, this node runs
// again from the top and interrupt() returns their answer. Nothing before the
// interrupt() calls may have side effects for that reason.
export async function approveNode(state) {
  const action = state.pending;
  let decision = "auto";

  if (action.kind === "form") {
    const answer = interrupt({
      type: "form",
      question: `The agent found a form on ${state.states[action.sourceStateId].url}. How should it handle it?`,
      action: { label: action.label, fields: action.target.fields, submitText: action.target.submitText },
      risky: action.risky,
      riskReason: action.riskReason,
      options: [
        { value: "skip", label: "Skip this form" },
        { value: "fill", label: "Fill it with test data, don't submit" },
        { value: "fill_submit", label: "Fill it with test data and submit" },
      ],
    });
    decision = ["skip", "fill", "fill_submit"].includes(answer) ? answer : "skip";
  } else if (action.risky) {
    const answer = interrupt({
      type: "risky_action",
      question: `${action.label} on ${state.states[action.sourceStateId].url} may have side effects. Allow it?`,
      action: { label: action.label, href: action.target.href },
      riskReason: action.riskReason,
      options: [
        { value: "approve", label: "Allow this action" },
        { value: "skip", label: "Skip it" },
      ],
    });
    decision = answer === "approve" ? "approve" : "skip";
  }

  if (decision === "skip") {
    const session = getSession(state.scanId);
    emit(session, "skip", `Skipped: ${action.label}`);
    return {
      decision,
      skipped: [...state.skipped, { label: action.label, kind: action.kind, reason: action.riskReason || "declined by user" }],
    };
  }
  return { decision };
}

// act: go to the screen the action belongs to, perform it, and record what
// happened (URL change, new screen, error signals, screenshot).
export async function actNode(state) {
  const session = getSession(state.scanId);
  const page = session.page;
  const action = state.pending;
  const source = state.states[action.sourceStateId];
  const n = state.counters.actions + 1;
  emit(session, "act", `#${n} ${action.label}`, { url: source.url });

  const result = {
    n,
    urlBefore: source.url,
    urlAfter: null,
    httpStatus: null,
    changed: false,
    isNewState: false,
    newStateId: null,
    error: null,
    signals: [],
    screenshot: null,
  };

  try {
    if (action.kind !== "visit") {
      await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page);
      for (const step of source.path) {
        await performAction(page, step.action, step.decision);
        await settle(page);
      }
    }
    session.signals = [];

    const out = await performAction(page, action, state.decision);
    await settle(page);
    result.httpStatus = out.httpStatus ?? null;
  } catch (err) {
    result.error = err.message.split("\n")[0].slice(0, 300);
  }

  try {
    result.urlAfter = page.url();
    const snapshot = await extractCandidates(page);
    const id = fingerprint(snapshot);
    const shot = await screenshot(session, `step-${String(n).padStart(2, "0")}`);
    result.screenshot = shot.file;
    result.changed = id !== source.id;
    result.isNewState = !state.states[id];
    result.newStateId = id;
    result.signals = session.signals.slice(0, 20);

    if (result.isNewState) {
      const sameUrl = normalizeUrl(result.urlAfter) === normalizeUrl(source.url);
      // Screens reached through an approved risky action are recorded but not
      // explored further: reaching them again would mean replaying that side
      // effect (e.g. a delete). Approved form submits only re-send fake test
      // data, so screens behind them stay explorable.
      const sideEffect = state.decision === "approve";
      const newStates = {
        ...state.states,
        [id]: {
          id,
          url: result.urlAfter,
          title: snapshot.title,
          path: action.kind === "visit" || !sameUrl ? [] : [...source.path, { action, decision: state.decision }],
          depth: action.depth,
          explorable: !sideEffect && !result.error,
          screenshot: shot.file,
        },
      };
      return {
        lastResult: result,
        states: newStates,
        counters: { ...state.counters, actions: n },
      };
    }
  } catch (err) {
    result.error = result.error || err.message.split("\n")[0].slice(0, 300);
  }

  return { lastResult: result, counters: { ...state.counters, actions: n } };
}

// evaluate: turn the action's outcome into notes and bug reports. Hard
// signals (JS errors, HTTP errors) are always recorded; the LLM is only asked
// when something looks wrong, to keep within free-tier rate limits.
export async function evaluateNode(state) {
  const session = getSession(state.scanId);
  const action = state.pending;
  const result = state.lastResult;

  const httpFailed = result.httpStatus !== null && result.httpStatus >= 400;
  const suspicious =
    result.signals.length > 0 ||
    !!result.error ||
    httpFailed ||
    (!result.changed && (action.kind === "click" || action.kind === "toggle"));

  let outcome = result.changed ? "worked" : "no_visible_effect";
  let summary = result.isNewState ? `Reached a new screen: ${result.urlAfter}` : "";
  let bugs = [];

  if (suspicious && canUseLlm(session) && result.screenshot) {
    try {
      session.llmCalls++;
      const verdict = await evaluateAction({
        screenshot: fs.readFileSync(result.screenshot),
        action: { label: action.label, kind: action.kind, href: action.target.href || null },
        result,
      });
      if (verdict) {
        outcome = verdict.outcome;
        summary = verdict.summary;
        bugs = verdict.bugs;
      }
    } catch (err) {
      noteLlmError(session, err);
      emit(session, "warning", `LLM evaluation failed, using signals only: ${err.message}`);
    }
  }

  // Without an LLM verdict, still report what the hard signals prove.
  if (suspicious && !bugs.length && (result.signals.length || result.error || httpFailed)) {
    bugs = signalBugs(action, result);
    if (bugs.length) outcome = "broken";
  }

  const evidence = { url: result.urlBefore, action: action.label, screenshot: result.screenshot, signals: result.signals };
  const newBugs = bugs.map((b) => ({ ...b, ...evidence }));
  if (newBugs.length) emit(session, "bug", `${newBugs.length} issue(s) found after: ${action.label}`);

  return {
    bugs: [...state.bugs, ...newBugs],
    actionsLog: [
      ...state.actionsLog,
      {
        n: result.n,
        label: action.label,
        kind: action.kind,
        decision: state.decision,
        priority: action.priority,
        reason: action.reason,
        urlBefore: result.urlBefore,
        urlAfter: result.urlAfter,
        outcome,
        summary,
        newScreen: result.isNewState,
        error: result.error,
        signals: result.signals.length,
        screenshot: result.screenshot,
      },
    ],
    counters: {
      ...state.counters,
      noNovelty: result.isNewState ? 0 : state.counters.noNovelty + 1,
    },
    currentStateId: result.isNewState ? result.newStateId : state.currentStateId,
  };
}

function signalBugs(action, result) {
  const bugs = [];
  if (result.httpStatus >= 400) {
    bugs.push({
      title: `${action.label} returns HTTP ${result.httpStatus}`,
      severity: result.httpStatus >= 500 ? "high" : "medium",
      description: `Navigating to ${action.target.href} returned HTTP ${result.httpStatus}.`,
      rca: result.httpStatus === 404 ? "Broken link: the target page does not exist." : "Server error on the target page.",
      suggested_fix: "Fix or remove the link, or restore the missing page.",
    });
  }
  for (const s of result.signals) {
    if (s.type === "js_exception") {
      bugs.push({
        title: `Uncaught JavaScript error after: ${action.label}`,
        severity: "high",
        description: s.message,
        rca: "An exception is thrown in page code and not handled.",
        suggested_fix: "Inspect the stack trace in the browser console and handle the failing case.",
      });
    } else if (s.type === "http_error" && s.status >= 500) {
      bugs.push({
        title: `Server error ${s.status} from ${new URL(s.url).pathname}`,
        severity: "high",
        description: `${s.resourceType} request to ${s.url} failed with ${s.status}.`,
        rca: "Backend endpoint is failing.",
        suggested_fix: "Check server logs for this endpoint.",
      });
    } else if (s.type === "console_error") {
      bugs.push({
        title: `Console error after: ${action.label}`,
        severity: "low",
        description: s.message,
        rca: "Client code logged an error.",
        suggested_fix: "Investigate the logged error in the browser console.",
      });
    }
  }
  if (result.error && !bugs.length) {
    bugs.push({
      title: `Could not perform: ${action.label}`,
      severity: "low",
      description: result.error,
      rca: "Element was hidden, covered by another element, or not interactable.",
      suggested_fix: "Check that the element is visible and not overlapped at this viewport size.",
    });
  }
  return bugs;
}

// report: write the final scan report for the dashboard.
export async function reportNode(state) {
  const session = getSession(state.scanId);

  const seen = new Set();
  const bugs = state.bugs.filter((b) => {
    const key = `${(b.title || "").toLowerCase()}|${b.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = { high: 0, medium: 1, low: 2 };
  bugs.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  const report = {
    scanId: state.scanId,
    startUrl: state.startUrl,
    finishedAt: new Date().toISOString(),
    stopReason: state.stopReason,
    limits,
    stats: {
      actions: state.counters.actions,
      screens: Object.keys(state.states).length,
      llmCalls: session.llmCalls,
      activeSeconds: Math.round(activeMs(session) / 1000),
      bugs: {
        total: bugs.length,
        high: bugs.filter((b) => b.severity === "high").length,
        medium: bugs.filter((b) => b.severity === "medium").length,
        low: bugs.filter((b) => b.severity === "low").length,
      },
      skipped: state.skipped.length,
      notTested: state.frontier.length,
    },
    landing: state.landing,
    bugs,
    actions: state.actionsLog,
    screens: Object.values(state.states).map(({ path: _path, ...s }) => s),
    skipped: state.skipped,
    notTested: state.frontier.map((a) => ({ label: a.label, kind: a.kind, risky: a.risky })),
  };

  fs.writeFileSync(path.join(session.dir, "report.json"), JSON.stringify(report, null, 2));
  emit(session, "done", `Scan finished (${state.stopReason}): ${report.stats.actions} actions, ${bugs.length} bugs`);
  return { finalReport: report };
}

// ------------------------------------------------------------- routing

export function afterSelect(state) {
  return state.pending ? "approve" : "report";
}

export function afterApprove(state) {
  return state.decision === "skip" ? "select" : "act";
}

export function afterEvaluate(state) {
  const r = state.lastResult;
  if (!r.isNewState) return "select";
  const screen = state.states[r.newStateId];
  return screen?.explorable && screen.depth < limits.maxDepth ? "observe" : "select";
}
