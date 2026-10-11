import { check, listCalls, writeCalls } from "../checks.js";
import { elementLabel, hasField, isTextish } from "../elements.js";
import { isLoginForm } from "./auth.js";
import { invalidValueFor } from "./invalidInput.js";

// Removes the browser-side validation so the server's own checks are tested.
async function stripClientValidation(t, el) {
  const target = await t.locate(el);
  await target.evaluate((node) => {
    const form = node.tagName === "FORM" ? node : node.form;
    if (form) form.noValidate = true;
    const fields = form ? [...form.elements] : [node];
    for (const f of fields) {
      for (const a of ["required", "pattern", "minlength", "maxlength", "min", "max"]) f.removeAttribute(a);
      if (["email", "url", "tel", "number"].includes(f.type)) f.type = "text";
    }
  });
}

function judge(obs) {
  const writes = writeCalls(obs);
  if (!writes.length) return { reached: false };
  const crashed = writes.find((n) => (n.status ?? 0) >= 500);
  const accepted = writes.find((n) => n.status != null && n.status < 400);
  return { reached: true, crashed, accepted, writes };
}

export default {
  id: "server-side-validation",
  name: "Server rejects bad data even without browser validation",
  scope: "element",
  categories: ["create", "update", "generic"],
  kinds: ["form", "input"],
  requires: ["mutations"],
  severity: "medium",
  spec: {
    action: "Remove required/pattern/type checks from the form, then submit it empty and with invalid formats",
    expectedNetwork: "Server answers 400/422 — never 2xx (accepted) or 5xx (crashed)",
    expectedStateChange: "No invalid record is saved",
    persistsOnReload: "After a reload the invalid record is not on the page",
  },
  fixHint:
    "Validate every field on the server too (required, format, length) and return 400/422 with field errors; client-side checks can be bypassed.",

  appliesTo(el) {
    return (el.kind === "form" || el.kind === "input") && hasField(el, isTextish) && !isLoginForm(el);
  },

  async run(t, el) {
    const label = elementLabel(el);
    const checks = [];

    await t.fresh();
    const empty = await t.act(`Submit ${label} empty with browser validation removed`, async () => {
      await stripClientValidation(t, el);
      for (const f of el.form.fields.filter(isTextish)) await t.field(f).fill("", { timeout: 5000 });
      await t.submitForm(el);
    }, { guard: false });
    const e = judge(empty);
    if (!e.reached) {
      checks.push(
        check("Empty submission reaches the server", false, {
          expected: "a request to test the server with",
          actual: "the page's own script stopped it before any request (server validation not testable this way)",
          severity: "low",
          soft: true,
        }),
      );
    } else {
      checks.push(
        check("Server doesn't crash on empty data", !e.crashed, {
          expected: "4xx",
          actual: listCalls(e.writes),
          severity: "high",
          issue: `Server error (${e.crashed?.status}) when ${label} is submitted empty`,
        }),
        check("Server rejects empty data", !e.accepted, {
          expected: "400/422",
          actual: listCalls(e.writes),
          severity: "medium",
          issue: `Server accepts an empty submission from ${label}`,
        }),
      );
    }

    const typed = el.form.fields.filter((f) => invalidValueFor(f) !== undefined);
    let persists = null;
    if (typed.length) {
      const marker = `BugOps-invalid-${Date.now().toString(36)}`;
      let first = true;
      await t.fresh();
      const bad = await t.act(`Submit ${label} with invalid formats and browser validation removed`, async () => {
        await stripClientValidation(t, el);
        await t.fillForm(el, (f) => {
          const invalid = invalidValueFor(f);
          if (invalid) return `${invalid}-${marker}`;
          if (isTextish(f) && first) {
            first = false;
            return marker;
          }
          return undefined;
        });
        await t.submitForm(el);
      }, { guard: false });
      const b = judge(bad);
      if (b.reached) {
        await t.reload();
        const stored = await t.hasText(marker);
        persists = stored;
        checks.push(
          check("Server doesn't crash on invalid formats", !b.crashed, {
            expected: "4xx",
            actual: listCalls(b.writes),
            severity: "high",
            issue: `Server error (${b.crashed?.status}) on an invalid ${typed[0].type || typed[0].name}`,
          }),
          check("Server rejects invalid formats", !b.accepted, {
            expected: "400/422",
            actual: `${listCalls(b.writes)}${stored ? "; record visible after reload" : ""}`,
            severity: "medium",
            issue: `Server accepts an invalid ${typed[0].type || typed[0].name || "value"} from ${label}`,
          }),
          check("Invalid record is not saved", !stored, {
            expected: "marker not on the page after reload",
            actual: stored ? "invalid record saved and shown" : "not saved",
            severity: "medium",
            issue: `Invalid data from ${label} is saved`,
          }),
        );
      }
    }

    return { primary: empty, persistsOnReload: persists === null ? null : !persists, checks };
  },
};
