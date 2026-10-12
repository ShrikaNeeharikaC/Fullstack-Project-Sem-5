import { extractCandidates, locateClickable, locateField } from "./dom.js";

// Logging in with the user's own account, shared by the crawler and the test
// library. Credentials only ever live in memory here: they are typed into the
// page and never written to graph state, reports, events or LLM prompts.

const SIGNUP = /sign\s*up|register|create\s*account|join/i;
const EXTRA_FIELDS = /confirm|repeat|first|last|full\s*name|phone|address/i;
const TEXTISH = (f) =>
  f.tag !== "select" && !["checkbox", "radio", "file", "password", "range", "color"].includes((f.type || "").toLowerCase());
const isPassword = (f) => (f.type || "").toLowerCase() === "password";

// A login form in an extractCandidates() snapshot: exactly one password field,
// at most three other text fields, and nothing that looks like sign-up.
export function findLoginForm(snapshot) {
  return (
    snapshot.forms.find((form) => {
      if (form.fields.filter(isPassword).length !== 1) return false;
      const text = form.fields.filter(TEXTISH);
      if (!text.length || text.length > 3) return false;
      if (text.some((f) => EXTRA_FIELDS.test(`${f.name || ""} ${f.placeholder || ""} ${f.label || ""}`))) return false;
      return !SIGNUP.test(form.submitText || "");
    }) || null
  );
}

// Same key planNode gives a form, so the crawler can recognise the login form
// in its to-do list.
export function formKey(pathname, form) {
  return `form:${pathname}:${form.fields.map((f) => f.name || f.placeholder || f.label || f.type).join(",")}`;
}

export function cleanCredentials(raw) {
  const username = typeof raw?.username === "string" ? raw.username.trim() : "";
  const password = typeof raw?.password === "string" ? raw.password : "";
  return username && password ? { username: username.slice(0, 200), password: password.slice(0, 200) } : null;
}

async function visiblePasswordFields(page) {
  return page
    .evaluate(
      () =>
        [...document.querySelectorAll('input[type="password"]')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        }).length,
    )
    .catch(() => 0);
}

// Fills the login form on the current page and submits it.
// Returns { ok, url, error }. ok = the password field is gone afterwards.
export async function performLogin(page, credentials, form = null) {
  const target = form || findLoginForm(await extractCandidates(page));
  if (!target) return { ok: false, url: page.url(), error: "No login form on this page" };

  try {
    const password = target.fields.find(isPassword);
    const username = target.fields.find(TEXTISH);
    await locateField(page, username).fill(credentials.username, { timeout: 5000 });
    await locateField(page, password).fill(credentials.password, { timeout: 5000 });
    if (target.submitDomIndex !== null) {
      const submit = await locateClickable(page, { domIndex: target.submitDomIndex, role: "button", text: target.submitText });
      await submit.click({ timeout: 5000 });
    } else {
      await locateField(page, password).press("Enter");
    }
  } catch (err) {
    return { ok: false, url: page.url(), error: err.message.split("\n")[0].slice(0, 200) };
  }

  // Single-page apps swap the form out without a navigation: wait for that.
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('input[type="password"]')].some((el) => el.getBoundingClientRect().width > 0),
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);

  if ((await visiblePasswordFields(page)) === 0) return { ok: true, url: page.url(), error: null };
  const message = await page
    .locator('[role="alert"], .error, .alert, [aria-invalid="true"] + *')
    .first()
    .innerText({ timeout: 1000 })
    .catch(() => "");
  return { ok: false, url: page.url(), error: message.trim().slice(0, 200) || "Still on the login form after submitting" };
}

// Before an action: if the app bounced us to a login form (session expired,
// or the agent pressed "Log out"), log in again and go back to `url`.
// Returns true when it had to log in again.
export async function ensureLoggedIn(page, credentials, url) {
  if (!credentials) return false;
  const form = findLoginForm(await extractCandidates(page));
  if (!form) return false;
  const result = await performLogin(page, credentials, form);
  if (!result.ok) return false;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  return true;
}
