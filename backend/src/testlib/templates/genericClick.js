import { check, errorChecks, somethingHappened } from "../checks.js";
import { elementLabel } from "../elements.js";

// The catch-all: a button should visibly do something and not throw.
export default {
  id: "button-responds",
  name: "Button responds to a click",
  scope: "element",
  categories: ["generic", "nav", "auth", "search", "create", "update", "upload"],
  kinds: ["button", "toggle"],
  requires: [],
  severity: "low",
  spec: {
    action: "Click the element (same-site writes are blocked by the safety guard)",
    expectedNetwork: "Any request it makes returns HTTP < 400",
    expectedStateChange: "Something visible changes: URL, DOM, aria state, storage, or a dialog opens",
    persistsOnReload: "n/a",
  },
  fixHint: "Check that a click handler is attached to this element and that nothing (an overlay or pointer-events: none) intercepts the click.",

  appliesTo(el) {
    return el.kind === "button" || el.kind === "toggle";
  },

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();
    const obs = await t.act(`Click ${label}`, async () => {
      const target = await t.locate(el);
      await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await target.click({ timeout: 5000 });
    });
    const happened = somethingHappened(obs) || obs.blocked.length > 0;

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Element is clickable", !obs.error, {
          expected: "click succeeds",
          actual: obs.error || "clicked",
          severity: "low",
          issue: `${label} cannot be clicked (hidden or covered by another element)`,
        }),
        check("Click has a visible effect", !!obs.error || happened, {
          expected: "URL, DOM, storage or network change",
          actual: happened
            ? obs.blocked.length
              ? "tried to write to the server (blocked by safety guard)"
              : "page changed"
            : "nothing changed",
          severity: "low",
          issue: `${label} does nothing when clicked`,
        }),
        ...errorChecks(obs, { what: `clicking ${label}` }),
      ],
    };
  },
};
