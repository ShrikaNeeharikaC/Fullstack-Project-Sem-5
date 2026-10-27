import { check } from "../checks.js";

const VERSION = /\d+\.\d+/;

// Page-level: the HTTP response headers that protect the page in the browser.
export default {
  id: "security-headers",
  name: "Security headers are set",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page and read the main document's response headers",
    expectedNetwork: "Main document response carries CSP, anti-framing, nosniff, HSTS (https) and Referrer-Policy headers",
    expectedStateChange: "n/a",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Add the headers in your server or framework (e.g. the helmet middleware for Express): Content-Security-Policy, frame-ancestors or X-Frame-Options, X-Content-Type-Options: nosniff, Strict-Transport-Security and Referrer-Policy; drop X-Powered-By and version numbers from Server.",

  async run(t) {
    await t.page.goto("about:blank");
    let headers = null;
    const load = await t.act("Load the page and read its response headers", async () => {
      const res = await t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      headers = res ? await res.allHeaders() : null;
    });
    if (!headers) return { skipped: `No response for the main document (${load.error || "served from cache"})` };

    const h = (name) => headers[name] || "";
    const https = t.url.startsWith("https:");
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(t.url);
    const csp = h("content-security-policy");
    const framing = /frame-ancestors/i.test(csp) || /^(deny|sameorigin)$/i.test(h("x-frame-options").trim());
    const unsafeCsp = /script-src[^;]*'unsafe-inline'/i.test(csp) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/i.test(csp);
    const hsts = h("strict-transport-security");
    const hstsAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] || 0);
    const leaks = [h("x-powered-by") && `X-Powered-By: ${h("x-powered-by")}`, VERSION.test(h("server")) && `Server: ${h("server")}`].filter(Boolean);
    const show = (name) => h(name).slice(0, 120) || "missing";

    return {
      primary: load,
      persistsOnReload: null,
      checks: [
        check("Content-Security-Policy is set", !!csp, {
          expected: "a Content-Security-Policy header",
          actual: show("content-security-policy"),
          severity: "medium",
          // Dev servers rarely send one; only a warning there.
          soft: local,
          issue: "No Content-Security-Policy header (no second line of defence against XSS)",
        }),
        check("CSP does not allow inline scripts", !unsafeCsp, {
          expected: "script-src without 'unsafe-inline' (or with nonces/hashes)",
          actual: unsafeCsp ? "script-src allows 'unsafe-inline'" : csp ? "ok" : "n/a (no CSP)",
          severity: "low",
          soft: true,
        }),
        check("Page cannot be framed by other sites", framing, {
          expected: "CSP frame-ancestors, or X-Frame-Options DENY/SAMEORIGIN",
          actual: `X-Frame-Options: ${show("x-frame-options")}`,
          severity: "medium",
          soft: local,
          issue: "Page can be embedded in an iframe by any site (clickjacking)",
        }),
        check("X-Content-Type-Options is nosniff", /nosniff/i.test(h("x-content-type-options")), {
          expected: "nosniff",
          actual: show("x-content-type-options"),
          severity: "low",
          issue: "Missing X-Content-Type-Options: nosniff",
        }),
        check("HSTS is enabled", !https || hstsAge >= 15552000, {
          expected: "Strict-Transport-Security max-age ≥ 180 days (https sites)",
          actual: https ? show("strict-transport-security") : "n/a (http)",
          severity: "low",
          issue: "HTTPS site without a long-lived Strict-Transport-Security header",
        }),
        check("Referrer-Policy is set", !!h("referrer-policy"), {
          expected: "e.g. strict-origin-when-cross-origin",
          actual: show("referrer-policy"),
          severity: "low",
          soft: true,
        }),
        check("Server software is not advertised", leaks.length === 0, {
          expected: "no X-Powered-By, no version in Server",
          actual: leaks.join("; ") || "none",
          severity: "low",
          issue: `Response reveals server software (${leaks.join("; ")})`,
        }),
      ],
    };
  },
};
