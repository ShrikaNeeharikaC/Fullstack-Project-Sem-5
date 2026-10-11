import { isDestructiveByKeyword } from "../../crawler/safety.js";
import { check, errorChecks } from "../checks.js";
import { elementLabel, extractElements, isTextish } from "../elements.js";

const NEXT = /next|continue|proceed|step|forward|›|→|»/i;
const MAX_STEPS = 5;

const formSignature = (el) => el.form.fields.map((f) => f.name || f.placeholder || f.label || f.type).join(",");

export default {
  id: "multi-step-form",
  name: "Multi-step form can be completed",
  scope: "element",
  categories: ["create", "generic", "auth", "update", "cart"],
  kinds: ["form"],
  requires: [],
  severity: "high",
  judge: true,
  spec: {
    action: `Fill each step with test data and press Next/Continue, up to ${MAX_STEPS} steps (stops before any pay/order/delete step)`,
    expectedNetwork: "Each step's requests succeed (server-side steps need --allow-mutations)",
    expectedStateChange: "Each step moves to the next one without errors; Back keeps the data already entered",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Check the handler of the failing step (its validation and the request it sends) and keep entered values in state when the user goes back.",

  appliesTo(el) {
    return el.kind === "form" && NEXT.test(`${el.form.submitText || ""} ${el.text || ""}`);
  },

  async run(t, el) {
    const guard = t.options.allowMutations ? false : "block";
    const checks = [];
    const seen = new Set();
    let current = el;
    let primary = null;
    let finished = false;
    let stopped = null;
    let steps = 0;

    let navigated = false;
    await t.fresh();
    const { elements: initial } = await extractElements(t.page);
    const otherForms = new Set(
      initial.filter((e) => e.kind === "form" && e.form.formIndex !== el.form.formIndex).map(formSignature),
    );
    for (let n = 1; n <= MAX_STEPS; n++) {
      if (isDestructiveByKeyword({ text: current.form.submitText })) {
        stopped = `stopped before "${current.form.submitText}" (final step has side effects)`;
        break;
      }
      seen.add(formSignature(current));
      const step = current;
      const obs = await t.act(`Step ${n}: fill ${elementLabel(step)} and continue`, async () => {
        await t.fillForm(step);
        await t.submitForm(step);
      }, { guard });
      primary = primary || obs;
      steps = n;
      if (obs.blocked.length) {
        stopped = "this step sends data to the server; blocked by the safety guard (run with --allow-mutations)";
        break;
      }
      const moved = obs.diff.url.changed || obs.diff.dom.changed;
      checks.push(
        check(`Step ${n} moves forward`, !obs.error && moved, {
          expected: "next step or confirmation appears",
          actual: obs.error || (moved ? (obs.diff.dom.addedText[0] || obs.urlAfter).slice(0, 80) : "nothing changed"),
          severity: "high",
          issue: `Multi-step form is stuck at step ${n}`,
        }),
        ...errorChecks(obs, { what: `step ${n} of the form` }).map((c) => ({ ...c, name: `Step ${n}: ${c.name}` })),
      );
      if (!moved || obs.error) break;

      // The next step is either the SAME <form> showing different fields
      // (in-page wizard) or a form on the new URL. Other forms that were
      // already on the page (search, newsletter...) are never followed.
      const { elements } = await extractElements(t.page);
      if (obs.diff.url.changed) navigated = true;
      const candidates = elements.filter((e) => e.kind === "form" && !seen.has(formSignature(e)));
      const next = obs.diff.url.changed
        ? candidates.find((e) => e.form.fields.some(isTextish)) || candidates[0]
        : candidates.find((e) => e.form.formIndex === step.form.formIndex && !otherForms.has(formSignature(e)));
      if (!next) {
        finished = true;
        break;
      }
      current = next;
    }

    if (steps < 2 && finished) {
      return { skipped: "Only one step: covered by the other form tests" };
    }

    // Going back must not lose what was typed. Only testable with a Back
    // button, or with browser Back when the steps were separate URLs.
    const backBtn = t.page.getByRole("button", { name: /back|previous|prev/i }).first();
    const hasBackButton = await backBtn.isVisible().catch(() => false);
    if (steps >= 2 && (hasBackButton || navigated)) {
      const back = await t.act("Go back one step", async () => {
        if (hasBackButton) await backBtn.click({ timeout: 5000 });
        else await t.page.goBack({ timeout: 10000 });
      }, { guard: "block" });
      const kept = await t.page
        .evaluate(() => [...document.querySelectorAll("input, textarea")].some((i) => i.offsetParent && i.type !== "hidden" && i.value))
        .catch(() => false);
      checks.push(
        check("Going back keeps the data already entered", kept, {
          expected: "previous step's fields still filled",
          actual: kept ? "kept" : `fields empty after going back (${back.urlAfter})`,
          severity: "low",
          issue: "Multi-step form loses entered data when going back",
        }),
      );
    }

    checks.push(
      check("Flow reaches an end", finished || !!stopped, {
        expected: `confirmation within ${MAX_STEPS} steps`,
        actual: stopped || (finished ? `finished after ${steps} step(s)` : `still going after ${steps} steps`),
        severity: "low",
        soft: true,
      }),
    );
    return { primary, persistsOnReload: null, checks };
  },
};
