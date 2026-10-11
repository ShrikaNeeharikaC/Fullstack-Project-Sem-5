import { check, listCalls } from "../checks.js";
import { isSameSite } from "../observer.js";

const SESSION_COOKIE = /sess|sid|token|auth|jwt|login|remember|csrf|xsrf/i;
const SECRET_KEY = /token|jwt|auth|secret|password|credential|session|api[-_]?key/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const SECRET_IN_URL = /[?&](password|passwd|pwd|token|access_token|api_key|apikey|secret|session)=/i;

// Page-level: cookies, browser storage and transport security.
export default {
  id: "storage-security",
  name: "Cookies, storage and transport are secure",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page and inspect cookies, localStorage/sessionStorage and requests",
    expectedNetwork: "No http:// requests from an https page; no secrets in request URLs",
    expectedStateChange: "Session cookies are HttpOnly + Secure; no tokens in localStorage/sessionStorage",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Set session cookies with HttpOnly, Secure and SameSite=Lax/Strict, keep auth tokens out of localStorage (use an HttpOnly cookie), and load every resource over https.",

  async run(t) {
    await t.page.goto("about:blank");
    const load = await t.act("Load the page", () => t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }));
    const https = t.url.startsWith("https:");

    const cookies = (await t.page.context().cookies()).filter((c) => isSameSite(`https://${c.domain.replace(/^\./, "")}`, t.url));
    const sessionCookies = cookies.filter((c) => SESSION_COOKIE.test(c.name));
    const notHttpOnly = sessionCookies.filter((c) => !c.httpOnly);
    const notSecure = https ? sessionCookies.filter((c) => !c.secure) : [];
    const noneWithoutSecure = cookies.filter((c) => c.sameSite === "None" && !c.secure);

    // Key names only: values are never written to the report.
    const storageSecrets = await t.page.evaluate(
      ({ keyRe, jwtRe }) => {
        const key = new RegExp(keyRe, "i");
        const jwt = new RegExp(jwtRe);
        const found = [];
        for (const [name, store] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
          try {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              const v = String(store.getItem(k) || "");
              if (key.test(k) || jwt.test(v) || /"(access_?token|id_?token|refresh_?token|jwt)"\s*:/i.test(v)) found.push(`${name}.${k}`);
            }
          } catch {}
        }
        return found;
      },
      { keyRe: SECRET_KEY.source, jwtRe: JWT.source },
    );

    const mixed = https ? load.network.filter((n) => n.url.startsWith("http:")) : [];
    const secretUrls = load.network.filter((n) => SECRET_IN_URL.test(n.url));
    const passwordOverHttp = !https && (await t.visiblePasswordFields()) > 0 && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(t.url);
    const names = (list) => list.map((c) => c.name).join(", ") || "none";

    return {
      primary: load,
      persistsOnReload: null,
      checks: [
        check("Session cookies are HttpOnly", notHttpOnly.length === 0, {
          expected: "HttpOnly on session/auth cookies",
          actual: names(notHttpOnly),
          severity: "medium",
          issue: `Session cookie readable by JavaScript (missing HttpOnly): ${names(notHttpOnly)}`,
        }),
        check("Session cookies are Secure", notSecure.length === 0, {
          expected: "Secure flag on session/auth cookies (https site)",
          actual: names(notSecure),
          severity: "medium",
          issue: `Session cookie sent over plain http (missing Secure): ${names(notSecure)}`,
        }),
        check("SameSite=None cookies are Secure", noneWithoutSecure.length === 0, {
          expected: "SameSite=None only with Secure",
          actual: names(noneWithoutSecure),
          severity: "low",
          issue: `Cookie with SameSite=None but no Secure flag: ${names(noneWithoutSecure)}`,
        }),
        check("No auth tokens in browser storage", storageSecrets.length === 0, {
          expected: "tokens kept in HttpOnly cookies, not storage",
          actual: storageSecrets.join(", ") || "none",
          severity: "medium",
          issue: `Auth token stored in browser storage (readable by any XSS): ${storageSecrets.join(", ")}`,
        }),
        check("No mixed content", mixed.length === 0, {
          expected: "every request over https",
          actual: listCalls(mixed),
          severity: "medium",
          issue: `${mixed.length} resource(s) loaded over http on an https page`,
        }),
        check("No secrets in request URLs", secretUrls.length === 0, {
          expected: "no password/token query parameters",
          actual: secretUrls.map((n) => n.url.replace(/=([^&]+)/g, "=…")).slice(0, 3).join(", ") || "none",
          severity: "medium",
          issue: "Secret sent in a URL query string (ends up in logs and history)",
        }),
        check("Password form is served over https", !passwordOverHttp, {
          expected: "password fields only on https pages",
          actual: passwordOverHttp ? "password field on an http page" : "ok",
          severity: "high",
          issue: "Password form served over plain http",
        }),
      ],
    };
  },
};
