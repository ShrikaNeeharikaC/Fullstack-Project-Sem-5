import { apiCalls, check, errorChecks, failedCalls, listCalls, userFeedback, writeCalls } from "../checks.js";
import { elementLabel, hasField, isPasswordField, isTextish } from "../elements.js";

const SIGNUP = /sign\s*up|register|create\s*account|join/i;
const EXTRA_FIELDS = /confirm|repeat|first|last|full\s*name|phone|address/i;

// A login form: one password field, an identifier, nothing that looks like
// sign-up (submitting a sign-up form with fake data would create an account).
export function isLoginForm(el) {
  if (el.kind !== "form" || !hasField(el, isPasswordField)) return false;
  const text = el.form.fields.filter(isTextish);
  if (text.length > 3 || el.form.fields.filter(isPasswordField).length !== 1) return false;
  if (text.some((f) => EXTRA_FIELDS.test(`${f.name || ""} ${f.placeholder || ""} ${f.label || ""}`))) return false;
  return !SIGNUP.test(`${el.form.submitText || ""} ${el.text || ""}`);
}

async function fillLogin(t, el, username, password) {
  await t.fillForm(el, (f) => {
    if (isPasswordField(f)) return password;
    if (isTextish(f)) return username;
    return undefined;
  });
}

// Signs of a session after login: password field gone and the user moved on.
async function looksLoggedIn(t, obs) {
  return (await t.visiblePasswordFields()) === 0 && (obs.diff.url.changed || obs.diff.dom.removedCount > 0);
}

export const invalidLogin = {
  id: "auth-invalid-login",
  name: "Login rejects invalid credentials",
  scope: "element",
  categories: ["auth"],
  kinds: ["form"],
  requires: [],
  severity: "high",
  spec: {
    action: "Submit the login form with a made-up email and wrong password",
    expectedNetwork: "Login request is sent and answered with 4xx (or rejected client-side), never 5xx",
    expectedStateChange: "User stays on the login form and sees an error message; no session is created",
    persistsOnReload: "n/a",
  },
  fixHint: "Return a 401 with a generic 'invalid email or password' message, show it next to the form, and never create a session for failed logins.",

  appliesTo: isLoginForm,

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();
    const obs = await t.act(`Log in with invalid credentials via ${label}`, async () => {
      await fillLogin(t, el, "bugops.invalid.user@example.com", "Wrong-Password-123!");
      await t.submitForm(el);
    }, { guard: "allow-post" });

    const loggedIn = await looksLoggedIn(t, obs);
    const responded = apiCalls(obs).length > 0 || userFeedback(obs);

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Invalid credentials are rejected", !loggedIn, {
          expected: "still on the login form",
          actual: loggedIn ? `password field gone, now at ${obs.urlAfter}` : "still on the login form",
          severity: "high",
          issue: "Login accepts invalid credentials",
        }),
        check("Login attempt gets a response", responded, {
          expected: "a login request or a visible message",
          actual: responded ? listCalls(writeCalls(obs)) : "no request and no message",
          severity: "high",
          issue: `${label}: submitting does nothing`,
        }),
        check("User sees an error message", userFeedback(obs), {
          expected: "error text, alert or invalid-field marker",
          actual: obs.diff.dom.addedText.slice(0, 2).join(" | ") || "no message",
          severity: "low",
          issue: "Failed login shows no error message",
        }),
        ...errorChecks(obs, { what: "a failed login" }),
      ],
    };
  },
};

export const validLogin = {
  id: "auth-login",
  name: "Login works and the session survives a reload",
  scope: "element",
  categories: ["auth"],
  kinds: ["form"],
  requires: ["credentials"],
  severity: "high",
  spec: {
    action: "Submit the login form with the configured test account",
    expectedNetwork: "Login request returns HTTP < 400",
    expectedStateChange: "Login form disappears; a session cookie or token is stored",
    persistsOnReload: "After a reload the user is still logged in",
  },
  fixHint: "Check the login endpoint response and that the session cookie/token is stored with the right domain, path and expiry.",

  appliesTo: isLoginForm,

  async run(t, el) {
    const { username, password } = t.options.credentials;
    await t.fresh();
    const obs = await t.act("Log in with the test account", async () => {
      await fillLogin(t, el, username, password);
      await t.submitForm(el);
    }, { guard: "allow-post" });

    const failed = failedCalls(obs);
    const loggedIn = await looksLoggedIn(t, obs);
    const sessionStored = obs.diff.cookies.any || obs.diff.storageChanged;
    const reload = await t.reload();
    const persists = loggedIn && (await t.visiblePasswordFields()) === 0;

    return {
      primary: obs,
      persistsOnReload: persists,
      checks: [
        check("Login request succeeds", failed.length === 0, {
          expected: "HTTP < 400",
          actual: listCalls(failed.length ? failed : writeCalls(obs)),
          severity: "high",
          issue: `Login request fails (HTTP ${failed[0]?.status})`,
        }),
        check("User is logged in", loggedIn, {
          expected: "login form gone",
          actual: loggedIn ? `at ${obs.urlAfter}` : "still on the login form",
          severity: "high",
          issue: "Valid test account cannot log in",
        }),
        check("Session is stored", !loggedIn || sessionStored, {
          expected: "new/changed cookie or storage entry",
          actual: sessionStored ? "stored" : "no cookie or storage change",
          severity: "medium",
          soft: true,
        }),
        ...errorChecks(obs, { what: "logging in" }),
        check("Session survives a reload", !loggedIn || persists, {
          expected: "still logged in after reload",
          actual: persists ? "still logged in" : `login form back at ${reload.urlAfter}`,
          severity: "high",
          issue: "User is logged out on page reload",
        }),
      ],
    };
  },
};
