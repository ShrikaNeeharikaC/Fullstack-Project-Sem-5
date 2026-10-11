import { check, errorChecks, listCalls, userFeedback, writeCalls } from "../checks.js";
import { elementLabel, hasField, isPasswordField, isTextish } from "../elements.js";

// Submitting a form empty should be stopped, not sent to the server or
// turned into a blank record.
export default {
  id: "form-empty-submit",
  name: "Empty form submission is validated",
  scope: "element",
  categories: ["create", "auth", "generic"],
  kinds: ["form", "input"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Clear every field and submit",
    expectedNetwork: "No write request (POST/PUT/PATCH) is sent with the empty data",
    expectedStateChange: "A validation message or invalid-field marker appears; no blank item is created",
    persistsOnReload: "n/a",
  },
  fixHint: "Add required attributes and a client-side check to the empty fields, and reject empty payloads on the server with a 400 and a clear message.",

  appliesTo(el) {
    return (el.kind === "form" || el.kind === "input") && hasField(el, isTextish);
  },

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();

    // Native HTML validation (required, type=email, ...) blocks the submit
    // itself; record whether the browser would do that.
    const nativeBlocks =
      el.kind === "form"
        ? await (await t.locate(el))
            .evaluate((f) => !f.noValidate && [...f.elements].some((e) => e.willValidate && !e.validity.valid && !e.value))
            .catch(() => false)
        : false;

    const obs = await t.act(`Submit ${label} empty`, async () => {
      for (const f of el.form.fields.filter(isTextish)) await t.field(f).fill("", { timeout: 5000 });
      await t.submitForm(el);
    });

    const sent = writeCalls(obs);
    // A new list row / table row with no text = a blank record was created.
    const blankItem = obs.diff.dom.added.some((sig) => /^(li|tr)\|.{0,1}$/.test(sig));
    const feedback = nativeBlocks || userFeedback(obs);
    const isRealForm = el.kind === "form";
    const severity = hasField(el, isPasswordField) || el.category === "create" ? "medium" : "low";

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Empty data is not sent to the server", sent.length === 0, {
          expected: "no POST/PUT/PATCH",
          actual: listCalls(sent),
          severity,
          issue: `${label} sends an empty submission to the server (no client-side validation)`,
        }),
        check("No blank item is created", !blankItem, {
          expected: "no new empty row",
          actual: blankItem ? `new empty element: ${obs.diff.dom.added.join(", ").slice(0, 120)}` : "none",
          severity: "medium",
          issue: `${label} creates a blank item when submitted empty`,
        }),
        check("User sees validation feedback", feedback || (!isRealForm && sent.length === 0 && !blankItem), {
          expected: "native validation, error text, aria-invalid or alert",
          actual: nativeBlocks
            ? "browser native validation"
            : feedback
              ? "message shown"
              : obs.blocked.length
                ? "not checked: the request was blocked by the safety guard, so a server-side message could not appear"
                : "no feedback",
          severity: "low",
          // A lone input (e.g. a todo box) may ignore Enter silently; a real
          // form should explain what's wrong. If our guard blocked the request,
          // the server never got to answer, so this can't be judged.
          soft: !isRealForm || obs.blocked.length > 0,
          issue: `${label} gives no feedback when submitted empty`,
        }),
        ...errorChecks(obs, { what: `submitting ${label} empty` }),
      ],
    };
  },
};
