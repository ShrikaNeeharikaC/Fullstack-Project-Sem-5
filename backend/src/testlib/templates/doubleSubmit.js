import { check, errorChecks, listCalls, writeCalls } from "../checks.js";
import { elementLabel } from "../elements.js";

// How long each write request is held before the guard sees it: a slow
// server is exactly when users click twice.
const SLOW_MS = 1500;

// Clicking submit twice should send one request, not create two records or
// charge twice. Runs with writes blocked, so nothing is actually saved: it
// counts the write requests the page TRIES to send.
export default {
  id: "double-submit",
  name: "Double-clicking submit sends only one request",
  scope: "element",
  categories: ["create", "auth", "cart"],
  kinds: ["form"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Fill the form and click its submit button twice quickly, with the network slowed down",
    expectedNetwork: "At most one write request (POST/PUT/PATCH) per submit (attempts are blocked by the safety guard)",
    expectedStateChange: "Submit button is disabled or shows a pending state after the first click",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Disable the submit button (or ignore clicks) while the request is in flight, and make the endpoint idempotent, e.g. with an idempotency key, so a repeated request cannot create a duplicate.",

  appliesTo(el) {
    return el.kind === "form" && el.form.submitDomIndex !== null;
  },

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();

    // Registered after the observer's route, so it runs first; fallback()
    // then hands the request on to the guard.
    const slow = async (route) => {
      if (["POST", "PUT", "PATCH"].includes(route.request().method())) await new Promise((r) => setTimeout(r, SLOW_MS));
      return route.fallback();
    };
    await t.page.route("**/*", slow);
    let disabledAfterFirst = null;
    let obs;
    try {
      obs = await t.act(`Fill ${label} and double-click submit (slow network)`, async () => {
        await t.fillForm(el);
        await t.submitForm(el);
        const submit = (await t.locate(el)).locator('button[type="submit"], input[type="submit"], button:not([type])').first();
        disabledAfterFirst = await submit
          .evaluate((b) => b.disabled || b.getAttribute("aria-disabled") === "true" || b.getAttribute("aria-busy") === "true")
          .catch(() => null);
        // force: a correctly disabled button must not make the click throw.
        await submit.click({ timeout: 2000, force: true }).catch(() => {});
        await t.page.waitForTimeout(SLOW_MS + 500);
      });
    } finally {
      await t.page.unroute("**/*", slow);
    }

    const writes = writeCalls(obs).filter((n) => t.sameSite(n.url));
    // Same method + URL sent more than once = a duplicate submission.
    const counts = new Map();
    for (const n of writes) counts.set(`${n.method} ${n.url}`, (counts.get(`${n.method} ${n.url}`) || 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1);

    if (!writes.length && !obs.error) {
      return { skipped: `${label} sent no write request when submitted (client-side only, or validation stopped it)` };
    }

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Form can be submitted", !obs.error, {
          expected: "submit succeeds",
          actual: obs.error || "submitted",
          severity: "low",
          issue: `${label} cannot be submitted`,
        }),
        check("Only one request per submission", dupes.length === 0, {
          expected: "each write request sent once",
          actual: dupes.length ? dupes.map(([call, n]) => `${call} ×${n}`).join("; ") : listCalls(writes),
          severity: "medium",
          issue: `Double-clicking submit on ${label} sends the request twice (duplicate records / charges)`,
        }),
        check("Submit button is disabled while sending", disabledAfterFirst !== false, {
          expected: "disabled / aria-busy after the first click",
          actual: disabledAfterFirst === null ? "n/a (button gone or replaced)" : disabledAfterFirst ? "disabled" : "still clickable",
          severity: "low",
          soft: true,
        }),
        ...errorChecks(obs, { what: `double-submitting ${label}` }),
      ],
    };
  },
};
