import crypto from "crypto";

// Observation layer: everything a test needs as evidence. It records network
// calls, console output, cookies and storage, and the DOM before and after
// each action, then diffs the before/after states.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_TYPES = new Set(["document", "fetch", "xhr", "websocket", "eventsource"]);
// Keys whose values must never be written to artifacts (only a hash is kept).
const SECRET_KEY = /pass|token|secret|auth|session|sess|jwt|sid|csrf|key|cred/i;

const hash = (v) => crypto.createHash("sha1").update(String(v)).digest("hex").slice(0, 10);

// "Same site" = same registrable domain (approximated as the last two labels),
// so api.example.com counts as part of www.example.com.
function siteOf(url) {
  try {
    const host = new URL(url).hostname;
    return host.split(".").slice(-2).join(".");
  } catch {
    return null;
  }
}

export function isSameSite(a, b) {
  const sa = siteOf(a);
  return !!sa && sa === siteOf(b);
}

function redactBody(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) if (SECRET_KEY.test(k)) obj[k] = "[REDACTED]";
      return JSON.stringify(obj).slice(0, 300);
    }
  } catch {}
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) {
    const params = new URLSearchParams(text);
    for (const k of [...params.keys()]) if (SECRET_KEY.test(k)) params.set(k, "[REDACTED]");
    return params.toString().slice(0, 300);
  }
  return text.slice(0, 300);
}

// Attaches listeners to the page and installs the network guard.
// Guard modes, set per action:
//   "block"      block same-site POST/PUT/PATCH/DELETE (default while probing)
//   "allow-post" block only PUT/PATCH/DELETE (search, login attempts)
//   false        allow everything (stateful tests that are meant to write)
export async function attachObserver(page, { origin }) {
  const network = [];
  const consoleLog = [];
  const byRequest = new WeakMap();
  let guard = false;

  const observer = {
    network,
    console: consoleLog,
    acceptDialogs: false,
    setGuard(mode) {
      guard = mode;
    },
    mark() {
      return { n: network.length, c: consoleLog.length };
    },
    since(mark) {
      return { network: network.slice(mark.n), console: consoleLog.slice(mark.c) };
    },
  };

  page.on("request", (req) => {
    const entry = {
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      postData: redactBody(req.postData()),
      status: null,
      failure: null,
      blocked: false,
      startedAt: Date.now(),
      durationMs: null,
    };
    network.push(entry);
    byRequest.set(req, entry);
  });
  page.on("response", (res) => {
    const entry = byRequest.get(res.request());
    if (entry) entry.status = res.status();
  });
  page.on("requestfinished", (req) => {
    const entry = byRequest.get(req);
    if (entry) entry.durationMs = Date.now() - entry.startedAt;
  });
  page.on("requestfailed", (req) => {
    const entry = byRequest.get(req);
    if (!entry) return;
    entry.failure = req.failure()?.errorText || "failed";
    entry.durationMs = Date.now() - entry.startedAt;
  });
  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    consoleLog.push({ type, text: msg.text().slice(0, 500), source: msg.location()?.url || null });
  });
  page.on("pageerror", (err) => {
    consoleLog.push({
      type: "pageerror",
      text: String(err.message || err).slice(0, 500),
      stack: String(err.stack || "").split("\n").slice(0, 4).join("\n"),
    });
  });
  // alert()/confirm() must never block a test. Dismissed by default; the
  // delete test accepts them because "Are you sure?" is part of that flow.
  page.on("dialog", (dialog) => {
    consoleLog.push({ type: "dialog", text: `${dialog.type()}: ${dialog.message()}`.slice(0, 300) });
    (observer.acceptDialogs ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });

  await page.route("**/*", (route) => {
    const req = route.request();
    const method = req.method();
    const blockThis =
      guard &&
      MUTATING.has(method) &&
      (guard === "block" || method !== "POST") &&
      ["document", "fetch", "xhr"].includes(req.resourceType()) &&
      isSameSite(req.url(), origin);
    if (blockThis) {
      const entry = byRequest.get(req);
      if (entry) entry.blocked = true;
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });

  return observer;
}

// The network calls worth reporting: documents and API calls, plus any static
// asset that failed. Successful images/fonts/CSS are noise.
export function relevantNetwork(entries) {
  return entries
    .filter((n) => API_TYPES.has(n.resourceType) || n.failure || (n.status ?? 0) >= 400)
    .map(({ method, url, resourceType, status, failure, blocked, postData, durationMs }) => ({
      method,
      url,
      resourceType,
      status,
      failure,
      blocked,
      postData,
      durationMs,
    }));
}

// Elements whose appearance/disappearance counts as a visible DOM change.
const SIGNATURE_SELECTOR =
  "a, button, input, select, textarea, label, h1, h2, h3, h4, h5, h6, li, tr, img, p, form, dialog, " +
  '[role="alert"], [role="dialog"], [role="status"], [aria-live], [role="listitem"], [role="option"], [role="tab"]';

// Reads the page's state: URL, cookies, storage and a DOM summary (plus the
// full HTML, which is saved to a file rather than kept in JSON).
export async function captureState(page) {
  const [cookies, snap] = await Promise.all([
    page.context().cookies().catch(() => []),
    page
      .evaluate((selector) => {
        const clean = (v) => (v || "").replace(/\s+/g, " ").trim().slice(0, 100);
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        // Long values keep a preview plus a hash of the WHOLE value, so a
        // change past the preview still shows up in the diff.
        const hashOf = (s) => {
          let h = 5381;
          for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
          return (h >>> 0).toString(36);
        };
        const readStore = (store) => {
          const out = {};
          try {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              const v = String(store.getItem(k));
              out[k] = v.length > 300 ? `${v.slice(0, 300)}… #${hashOf(v)}` : v;
            }
          } catch {}
          return out;
        };
        const safeCount = (sel) => {
          try {
            return document.querySelectorAll(sel).length;
          } catch {
            return 0;
          }
        };
        const elements = [...document.querySelectorAll(selector)]
          .filter(visible)
          .slice(0, 1500)
          .map((el) => {
            // Fields are identified by name/placeholder, not their current
            // value: typing into a field is not "the page changed".
            const isField =
              (el.tagName === "INPUT" && !["submit", "button", "reset"].includes(el.type)) ||
              el.tagName === "TEXTAREA" ||
              el.tagName === "SELECT";
            const label = isField
              ? el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("name") || el.type
              : el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("aria-label");
            return `${el.tagName.toLowerCase()}|${clean(label)}`;
          });
        // aria-expanded/pressed/checked flips and "open"/"active" class toggles
        // don't change text, so track them too.
        const toggles = [
          ...document.querySelectorAll('[aria-expanded="true"], [aria-pressed="true"], [aria-selected="true"], :checked'),
        ].map((el) => `${el.tagName.toLowerCase()}|${clean(el.innerText || el.getAttribute("aria-label") || el.name)}`);
        for (const el of document.querySelectorAll(
          '[class*="open"], [class*="active"], [class*="show"], [class*="expand"], [class*="visible"], [class*="selected"]',
        )) {
          toggles.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`);
        }
        const text = (document.body?.innerText || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 2000);
        return {
          title: document.title,
          localStorage: readStore(window.localStorage),
          sessionStorage: readStore(window.sessionStorage),
          html: document.documentElement.outerHTML.slice(0, 500_000),
          dom: {
            nodeCount: document.getElementsByTagName("*").length,
            scrollY: Math.round(window.scrollY),
            elements,
            toggles,
            text,
            alerts: [...document.querySelectorAll('[role="alert"], [aria-live]')]
              .map((e) => clean(e.innerText))
              .filter(Boolean),
            ariaInvalid: safeCount('[aria-invalid="true"]'),
            userInvalid: safeCount(":user-invalid"),
          },
        };
      }, SIGNATURE_SELECTOR)
      .catch(() => null),
  ]);

  const redactStore = (store) =>
    Object.fromEntries(Object.entries(store || {}).map(([k, v]) => [k, SECRET_KEY.test(k) ? `hash:${hash(v)}` : v]));

  return {
    url: page.url(),
    title: snap?.title ?? "",
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      expires: c.expires,
      valueHash: hash(c.value),
    })),
    localStorage: redactStore(snap?.localStorage),
    sessionStorage: redactStore(snap?.sessionStorage),
    dom: snap?.dom ?? {
      nodeCount: 0,
      scrollY: 0,
      elements: [],
      toggles: [],
      text: [],
      alerts: [],
      ariaInvalid: 0,
      userInvalid: 0,
    },
    html: snap?.html ?? "",
  };
}

// Items in `a` that are not in `b`, counting duplicates.
function multisetMinus(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const out = [];
  for (const x of a) {
    const n = counts.get(x) || 0;
    if (n > 0) counts.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

function diffRecord(before, after) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  return { added, removed, changed, any: added.length + removed.length + changed.length > 0 };
}

export function diffState(before, after) {
  const added = multisetMinus(after.dom.elements, before.dom.elements);
  const removed = multisetMinus(before.dom.elements, after.dom.elements);
  const beforeText = new Set(before.dom.text);
  const afterText = new Set(after.dom.text);
  const addedText = after.dom.text.filter((l) => !beforeText.has(l));
  const removedText = before.dom.text.filter((l) => !afterText.has(l));
  const togglesChanged =
    multisetMinus(after.dom.toggles, before.dom.toggles).length + multisetMinus(before.dom.toggles, after.dom.toggles).length > 0;
  const beforeAlerts = new Set(before.dom.alerts);

  const cookieMap = (list) => Object.fromEntries(list.map((c) => [`${c.name}@${c.domain}`, c.valueHash]));
  const cookies = diffRecord(cookieMap(before.cookies), cookieMap(after.cookies));
  const localStorage = diffRecord(before.localStorage, after.localStorage);
  const sessionStorage = diffRecord(before.sessionStorage, after.sessionStorage);

  return {
    url: { changed: before.url !== after.url, from: before.url, to: after.url },
    title: { changed: before.title !== after.title, from: before.title, to: after.title },
    dom: {
      changed:
        added.length + removed.length + addedText.length + removedText.length > 0 ||
        togglesChanged ||
        Math.abs(after.dom.scrollY - before.dom.scrollY) > 50,
      nodeDelta: after.dom.nodeCount - before.dom.nodeCount,
      addedCount: added.length,
      removedCount: removed.length,
      added: added.slice(0, 25),
      removed: removed.slice(0, 25),
      addedText: addedText.slice(0, 25),
      removedText: removedText.slice(0, 25),
      newAlerts: after.dom.alerts.filter((a) => !beforeAlerts.has(a)).slice(0, 10),
      togglesChanged,
      ariaInvalidDelta: after.dom.ariaInvalid - before.dom.ariaInvalid,
      userInvalidDelta: after.dom.userInvalid - before.dom.userInvalid,
    },
    cookies,
    localStorage,
    sessionStorage,
    storageChanged: localStorage.any || sessionStorage.any,
  };
}

// One-line descriptions of a diff, for reports and BugOps RCA text.
export function summarizeDiff(diff) {
  const out = [];
  const path = (u) => {
    try {
      const x = new URL(u);
      return x.pathname + x.search + x.hash;
    } catch {
      return u;
    }
  };
  if (diff.url.changed) out.push(`URL ${path(diff.url.from)} → ${path(diff.url.to)}`);
  if (diff.dom.changed) {
    out.push(`DOM +${diff.dom.addedCount}/−${diff.dom.removedCount} elements (${diff.dom.nodeDelta >= 0 ? "+" : ""}${diff.dom.nodeDelta} nodes)`);
  } else {
    out.push("DOM unchanged");
  }
  if (diff.dom.addedText.length) out.push(`new text: ${diff.dom.addedText.slice(0, 3).map((t) => `"${t.slice(0, 60)}"`).join(", ")}`);
  if (diff.dom.newAlerts.length) out.push(`alert: "${diff.dom.newAlerts[0].slice(0, 80)}"`);
  for (const [name, d] of [
    ["cookies", diff.cookies],
    ["localStorage", diff.localStorage],
    ["sessionStorage", diff.sessionStorage],
  ]) {
    if (!d.any) continue;
    const parts = [...d.added.map((k) => `+${k}`), ...d.removed.map((k) => `−${k}`), ...d.changed.map((k) => `~${k}`)];
    out.push(`${name}: ${parts.slice(0, 5).join(", ")}`);
  }
  return out;
}

export function describeCall(n) {
  let path = n.url;
  try {
    const u = new URL(n.url);
    path = u.origin + u.pathname;
  } catch {}
  const outcome = n.blocked ? "blocked by safety guard" : n.failure ? `failed (${n.failure})` : n.status ?? "pending";
  return `${n.method} ${path} → ${outcome}`;
}

export { MUTATING, API_TYPES };
