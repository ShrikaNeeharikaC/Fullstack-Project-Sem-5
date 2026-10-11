import { API_TYPES, MUTATING, describeCall, isSameSite } from "./observer.js";

// Building blocks shared by the templates. Every template returns a list of
// checks; a test fails if any non-soft check fails. Soft checks are reported
// as warnings only.
//   issue    = the BugOps title used if this check fails
//   severity = high (broken core flow) | medium (broken link/image, errors) | low (cosmetic)
export function check(name, pass, { expected, actual, severity, soft = false, issue } = {}) {
  return { name, pass: !!pass, expected, actual, severity, soft, issue };
}

// Requests our own safety guard aborts make Chrome log this; not a page bug.
const GUARD_NOISE = /ERR_BLOCKED_BY_CLIENT/;

// When the guard aborts a fetch, page code that doesn't catch it throws
// "Failed to fetch". That is our doing, so it isn't counted.
const BLOCKED_FETCH = /Failed to fetch|NetworkError|Load failed|ERR_BLOCKED_BY_CLIENT/i;
export const jsErrors = (obs) =>
  obs.console.filter((c) => c.type === "pageerror" && !(obs.blocked.length && BLOCKED_FETCH.test(c.text)));
export const consoleErrors = (obs) => obs.console.filter((c) => c.type === "error" && !GUARD_NOISE.test(c.text));

// Errors from other sites' scripts (ads, analytics, widgets) are reported
// separately as warnings: the site owner often can't fix them directly.
// First-party = the error's source/stack mentions this site, or no URL at all.
export function isThirdParty(entry, siteUrl) {
  const urls = `${entry.source || ""} ${entry.stack || ""}`.match(/https?:\/\/[^\s)'"]+/g) || [];
  return urls.length > 0 && !urls.some((u) => isSameSite(u, siteUrl));
}
export const apiCalls = (obs) => obs.network.filter((n) => API_TYPES.has(n.resourceType));
export const writeCalls = (obs) => apiCalls(obs).filter((n) => MUTATING.has(n.method));
export const failedCalls = (obs, min = 400) => apiCalls(obs).filter((n) => !n.blocked && (n.status ?? 0) >= min);
export const dialogs = (obs) => obs.console.filter((c) => c.type === "dialog");

// Did the action have ANY observable effect?
export function somethingHappened(obs) {
  const d = obs.diff;
  return (
    d.url.changed ||
    d.dom.changed ||
    d.storageChanged ||
    d.cookies.any ||
    apiCalls(obs).length > 0 ||
    dialogs(obs).length > 0
  );
}

// Visible feedback after a submit: new text, an alert region, a dialog, or
// fields marked invalid.
export function userFeedback(obs) {
  const d = obs.diff.dom;
  return (
    d.addedText.length > 0 ||
    d.newAlerts.length > 0 ||
    d.ariaInvalidDelta > 0 ||
    d.userInvalidDelta > 0 ||
    dialogs(obs).length > 0
  );
}

export const listCalls = (calls) => calls.slice(0, 5).map(describeCall).join("; ") || "none";
export const listConsole = (entries) => entries.slice(0, 3).map((c) => c.text.slice(0, 160)).join(" | ") || "none";

// The standard "nothing blew up" checks, run after every action.
export function errorChecks(obs, { what = "the action", jsSeverity = "medium" } = {}) {
  const allJs = jsErrors(obs);
  const js = allJs.filter((c) => !isThirdParty(c, obs.urlBefore));
  const thirdParty = allJs.filter((c) => isThirdParty(c, obs.urlBefore));
  const server = failedCalls(obs, 500);
  const client = failedCalls(obs, 400).filter((n) => n.status < 500);
  return [
    check("No uncaught JavaScript exceptions", js.length === 0, {
      expected: "0 exceptions",
      actual: listConsole(js),
      severity: jsSeverity,
      issue: `Uncaught JavaScript error after ${what}`,
    }),
    check("No third-party script exceptions", thirdParty.length === 0, {
      expected: "0 exceptions from other sites' scripts",
      actual: listConsole(thirdParty),
      severity: "low",
      soft: true,
    }),
    check("No server errors (5xx)", server.length === 0, {
      expected: "no 5xx responses",
      actual: listCalls(server),
      severity: "high",
      issue: `Server error after ${what}`,
    }),
    check("No failed API calls (4xx)", client.length === 0, {
      expected: "no 4xx responses",
      actual: listCalls(client),
      severity: "low",
      soft: true,
    }),
  ];
}
