import { check, errorChecks, failedCalls, jsErrors, listCalls, userFeedback, writeCalls } from "../checks.js";
import { elementLabel, hasField, isTextish } from "../elements.js";
import { isLoginForm } from "./auth.js";

// Each payload records its own token, so a payload stored by an earlier test
// (which fires on every page load) isn't blamed on this form.
const xssPayload = (token) => `"><img src=x onerror="(window.__bugopsXss=window.__bugopsXss||[]).push('${token}')">`;
const xssFired = (page, token) => page.evaluate((tk) => (window.__bugopsXss || []).includes(tk), token).catch(() => false);
const SQL = `' OR '1'='1' --`;
const DB_ERROR = /SQL syntax|mysql_|ORA-\d{5}|sqlite3?\.|psql:|SQLSTATE|syntax error at or near|unclosed quotation mark|PG::|SequelizeDatabaseError/i;

// A value of the right "shape" for the field's type that is still invalid.
export function invalidValueFor(f) {
  const type = (f.type || "").toLowerCase();
  const hint = `${f.name || ""} ${f.placeholder || ""} ${f.label || ""}`.toLowerCase();
  if (type === "email" || hint.includes("email")) return "not-an-email";
  if (type === "url" || /website|\burl\b|link/.test(hint)) return "not a url";
  if (type === "tel" || /phone|mobile/.test(hint)) return "abc-not-a-phone";
  return undefined;
}

// Was the bad data stopped? By the browser, by a visible message, or by the
// server answering 4xx.
function rejected(obs, nativeInvalid) {
  const sent = writeCalls(obs);
  if (!sent.length) return { ok: true, how: nativeInvalid ? "browser validation" : userFeedback(obs) ? "message shown" : "not sent" };
  if (sent.every((n) => !n.blocked && n.status >= 400 && n.status < 500)) return { ok: true, how: `server rejected it (${sent[0].status})` };
  return { ok: false, how: listCalls(sent) };
}

const formInvalid = (t, el) =>
  el.kind === "form"
    ? t.locate(el).then((f) => f.evaluate((form) => !form.noValidate && !form.checkValidity())).catch(() => false)
    : Promise.resolve(false);

export default {
  id: "form-invalid-input",
  name: "Form rejects invalid, oversized and malicious input",
  scope: "element",
  categories: ["create", "update", "generic", "auth"],
  kinds: ["form", "input"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Submit (1) wrongly formatted email/url/phone, (2) 5,000-character text, (3) XSS and SQL-injection strings",
    expectedNetwork: "Invalid data is not sent, or the server answers 4xx; never 5xx",
    expectedStateChange: "A validation message appears; injected HTML never runs; no database error text is shown",
    persistsOnReload: "With --allow-mutations: the injected script still doesn't run after a reload (no stored XSS)",
  },
  fixHint:
    "Validate formats on both client and server, cap text length, escape user input when rendering (never innerHTML raw input), and use parameterised queries.",

  appliesTo(el) {
    return (el.kind === "form" || el.kind === "input") && hasField(el, isTextish) && !isLoginForm(el);
  },

  async run(t, el) {
    const label = elementLabel(el);
    const guard = t.options.allowMutations ? false : "block";
    const checks = [];
    let primary = null;

    // 1. Wrong formats.
    const typed = el.form.fields.filter((f) => invalidValueFor(f) !== undefined);
    if (typed.length) {
      await t.fresh();
      let nativeInvalid = false;
      const obs = await t.act(`Submit ${label} with invalid ${typed.map((f) => f.type || f.name).join("/")}`, async () => {
        await t.fillForm(el, invalidValueFor);
        nativeInvalid = await formInvalid(t, el);
        await t.submitForm(el);
      }, { guard });
      primary = obs;
      const r = rejected(obs, nativeInvalid);
      checks.push(
        check("Invalid formats are rejected", r.ok, {
          expected: "browser validation, an error message, or a 4xx",
          actual: r.how,
          severity: "medium",
          issue: `${label} accepts an invalid ${typed[0].type || typed[0].name || "value"} without validation`,
        }),
        ...errorChecks(obs, { what: "submitting invalid formats" }),
      );
    }

    // 2. Very long input.
    await t.fresh();
    const widthBefore = await t.page.evaluate(() => document.documentElement.scrollWidth);
    const long = await t.act(`Submit ${label} with 5,000-character text`, async () => {
      await t.fillForm(el, (f) => (isTextish(f) && !invalidValueFor(f) ? "A".repeat(5000) : undefined));
      await t.submitForm(el);
    }, { guard });
    primary = primary || long;
    const widthAfter = await t.page.evaluate(() => document.documentElement.scrollWidth);
    checks.push(
      check("Long input doesn't crash the server", failedCalls(long, 500).length === 0, {
        expected: "no 5xx",
        actual: listCalls(failedCalls(long, 500)),
        severity: "high",
        issue: `Server error when ${label} gets very long input`,
      }),
      check("Long input doesn't throw", jsErrors(long).length === 0, {
        expected: "0 exceptions",
        actual: jsErrors(long).map((c) => c.text).join(" | ").slice(0, 200) || "none",
        severity: "medium",
        issue: `JavaScript error when ${label} gets very long input`,
      }),
      check("Long input doesn't break the layout", widthAfter <= Math.max(widthBefore, 1440) + 2, {
        expected: "page width unchanged",
        actual: `${widthBefore}px → ${widthAfter}px`,
        severity: "low",
        issue: `Very long input stretches the page sideways (${widthAfter}px)`,
      }),
    );

    // 3. Injection strings: XSS in the first text field, SQL in the rest.
    await t.fresh();
    let firstText = true;
    const token = `x${Date.now().toString(36)}`;
    const XSS = xssPayload(token);
    const inject = await t.act(`Submit ${label} with XSS and SQL-injection strings`, async () => {
      await t.fillForm(el, (f) => {
        if (!isTextish(f)) return undefined;
        if (invalidValueFor(f) === "not-an-email") return "bugops@example.com";
        const v = firstText ? XSS : SQL;
        firstText = false;
        return v;
      });
      await t.submitForm(el);
    }, { guard });
    const xssRan = await xssFired(t.page, token);
    const dbError = await t.page.evaluate((re) => new RegExp(re, "i").test(document.body.innerText), DB_ERROR.source).catch(() => false);
    let storedXss = null;
    if (guard === false && writeCalls(inject).length) {
      await t.reload();
      storedXss = await xssFired(t.page, token);
    }
    checks.push(
      check("Injected HTML/script never runs (XSS)", !xssRan, {
        expected: "input shown as text, not executed",
        actual: xssRan ? "the injected onerror handler ran" : "not executed",
        severity: "high",
        issue: `Cross-site scripting: ${label} renders input as HTML`,
      }),
      check("No database error is exposed", !dbError, {
        expected: "no SQL/database error text on the page",
        actual: dbError ? "database error text visible" : "none",
        severity: "high",
        issue: `Possible SQL injection: database error shown after quote characters in ${label}`,
      }),
      check("Injection strings don't crash the server", failedCalls(inject, 500).length === 0, {
        expected: "no 5xx",
        actual: listCalls(failedCalls(inject, 500)),
        severity: "high",
        issue: `Server error on quote characters in ${label} (possible injection)`,
      }),
      check("Stored input doesn't run after reload (stored XSS)", storedXss !== true, {
        expected: "script still not executed after reload",
        actual: storedXss === null ? "n/a (nothing saved, or run without --allow-mutations)" : storedXss ? "executed after reload" : "not executed",
        severity: "high",
        issue: "Stored cross-site scripting: saved input runs as script on reload",
      }),
    );

    return { primary, persistsOnReload: storedXss === null ? null : !storedXss, checks };
  },
};
