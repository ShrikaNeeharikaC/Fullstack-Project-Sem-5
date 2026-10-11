import { check, errorChecks, failedCalls, listCalls, writeCalls } from "../checks.js";
import { elementLabel } from "../elements.js";

// Reads the number on the cart badge ("Cart (3)", a bubble with "3"), or null.
function readCartCount(page) {
  return page
    .evaluate(() => {
      const re = /cart|bag|basket|minicart/i;
      for (const el of document.querySelectorAll("a, button, [class*=cart], [id*=cart], [aria-label]")) {
        const hint = `${el.id} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("href") || ""} ${el.innerText || ""}`;
        if (!re.test(hint)) continue;
        const m = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.match(/\d+/);
        if (m) return Number(m[0]);
      }
      return null;
    })
    .catch(() => null);
}

export default {
  id: "add-to-cart",
  name: "Add to cart updates the cart and persists",
  scope: "element",
  categories: ["cart"],
  kinds: ["button", "link"],
  requires: ["mutations"],
  onePerPage: true,
  severity: "high",
  judge: true,
  spec: {
    action: "Click the add-to-cart control (checkout/purchase is never clicked)",
    expectedNetwork: "A cart request returns HTTP < 400, or the cart is saved to cookies/storage",
    expectedStateChange: "The cart count goes up or an 'added to cart' confirmation appears",
    persistsOnReload: "The cart count is the same after a reload",
  },
  fixHint: "Check the add-to-cart endpoint and that the cart badge reads from the saved cart rather than a stale in-memory value.",

  appliesTo(el) {
    return (el.kind === "button" || el.kind === "link") && /add|cart|bag|basket/i.test(`${el.text} ${el.ariaLabel || ""}`);
  },

  async run(t, el) {
    const label = elementLabel(el);
    await t.fresh();
    const before = await readCartCount(t.page);
    const obs = await t.act(`Click ${label}`, async () => {
      await (await t.locate(el)).click({ timeout: 5000 });
    }, { guard: false });
    const after = await readCartCount(t.page);

    const writes = writeCalls(obs);
    const failed = failedCalls(obs);
    const saved = failed.length === 0 && (writes.length > 0 || obs.diff.storageChanged || obs.diff.cookies.any);
    const confirmed = obs.diff.dom.addedText.some((l) => /added|cart|bag|basket/i.test(l));
    const updated = (after !== null && after > (before ?? 0)) || confirmed;

    await t.reload();
    const afterReload = await readCartCount(t.page);
    const persists = after === null ? null : afterReload === after;

    return {
      primary: obs,
      persistsOnReload: persists,
      checks: [
        check("Cart is saved", saved, {
          expected: "cart request < 400 or cookie/storage change",
          actual: failed.length ? listCalls(failed) : writes.length ? listCalls(writes) : obs.diff.storageChanged ? "saved to storage" : "nothing saved",
          severity: "high",
          issue: failed.length ? `Add-to-cart request fails (HTTP ${failed[0].status})` : "Add to cart saves nothing",
        }),
        check("Cart updates", updated, {
          expected: "cart count goes up or confirmation shown",
          actual: `count ${before ?? "?"} → ${after ?? "?"}${confirmed ? ", confirmation shown" : ""}`,
          severity: "high",
          issue: "Cart does not update after Add to cart",
        }),
        ...errorChecks(obs, { what: "adding to cart" }),
        check("Cart survives a reload", persists !== false, {
          expected: `count stays ${after}`,
          actual: persists === null ? "n/a (no cart counter found)" : `count after reload ${afterReload}`,
          severity: "high",
          issue: "Cart is emptied on page reload",
        }),
      ],
    };
  },
};
