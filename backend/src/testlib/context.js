import fs from "fs";
import path from "path";
import { locateClickable, locateField } from "../crawler/dom.js";
import { testValueFor } from "../crawler/safety.js";
import { captureState, diffState, isSameSite, relevantNetwork } from "./observer.js";
import { isTextish } from "./elements.js";

export async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
}

const firstLine = (msg) => String(msg || "").split("\n")[0].slice(0, 300);

// What every template gets: the live page plus helpers that observe each
// action. One context per suite run; begin() switches it to the next test.
export class TestContext {
  constructor({ page, observer, url, dir, options }) {
    this.page = page;
    this.observer = observer;
    this.url = url;
    this.dir = dir;
    this.options = options;
    // Data passed between tests on the same page (e.g. the item create-item
    // made, which delete-item is then allowed to delete).
    this.shared = {};
    this.exploration = [];
    this.step = 0;
    this.testId = null;
    this.actions = [];
    // Clicks to replay after loading the page, for elements that only
    // appear after an interaction (a menu item behind "Menu", say).
    this.path = [];
  }

  begin(testId, path = []) {
    this.testId = testId;
    this.actions = [];
    this.path = path;
  }

  sameSite(url) {
    return isSameSite(url, this.url);
  }

  // Back to the page under test with a clean slate for this test, then
  // replay the clicks that reveal the element (writes blocked meanwhile).
  async fresh() {
    await this.page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(this.page);
    if (!this.path.length) return;
    this.observer.setGuard("block");
    try {
      for (const opener of this.path) {
        await (await this.locate(opener)).click({ timeout: 5000 });
        await settle(this.page);
      }
    } finally {
      this.observer.setGuard(false);
    }
  }

  // Performs one action and records what changed: URL, DOM diff, network,
  // console, storage. `guard` is the observer's network guard mode.
  async act(label, fn, { guard = "block", acceptDialogs = false } = {}) {
    const page = this.page;
    const before = await captureState(page);
    const mark = this.observer.mark();
    this.observer.setGuard(guard);
    this.observer.acceptDialogs = acceptDialogs;

    let error = null;
    try {
      await fn();
    } catch (err) {
      error = firstLine(err.message);
    }
    await settle(page);

    this.observer.setGuard(false);
    this.observer.acceptDialogs = false;
    const after = await captureState(page);
    const { network, console: consoleLog } = this.observer.since(mark);

    const step = ++this.step;
    const slug = String(step).padStart(3, "0");
    const domBefore = path.join(this.dir, "dom", `${slug}-before.html`);
    const domAfter = path.join(this.dir, "dom", `${slug}-after.html`);
    const shot = path.join(this.dir, "shots", `${slug}.png`);
    fs.writeFileSync(domBefore, before.html);
    fs.writeFileSync(domAfter, after.html);
    await page.screenshot({ path: shot }).catch(() => {});

    const calls = relevantNetwork(network);
    const obs = {
      step,
      testId: this.testId,
      label,
      urlBefore: before.url,
      urlAfter: after.url,
      error,
      diff: diffState(before, after),
      network: calls,
      blocked: calls.filter((n) => n.blocked),
      console: consoleLog,
      dom: { before: domBefore, after: domAfter },
      screenshot: shot,
    };
    this.actions.push(obs);
    this.exploration.push(obs);
    // Live state for the template's own checks; not written to the report.
    Object.defineProperty(obs, "state", { value: after, enumerable: false });
    return obs;
  }

  reload() {
    return this.act("Reload the page", () => this.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }));
  }

  // The page, or the iframe the element lives in.
  root(x) {
    if (x?.frameUrl) {
      const frame = this.page.frames().find((f) => f.url() === x.frameUrl);
      if (frame) return frame;
    }
    return this.page;
  }

  // Finds an element from the categorized list on the live page.
  async locate(el) {
    const root = this.root(el);
    // Non-standard and shadow-DOM elements carry a CSS path (Playwright's CSS
    // engine pierces open shadow roots, so host >> inner works).
    if (el.css) {
      const loc = root.locator(el.css);
      return (el.inner ? loc.locator(el.inner) : loc).first();
    }
    if (el.kind === "link" || el.kind === "button") return locateClickable(root, el.raw);
    if (el.kind === "toggle" || el.kind === "input") return this.field(el.form.fields[0]);
    return root.locator("form").nth(el.form.formIndex);
  }

  field(f) {
    const root = this.root(f);
    if (f.css) {
      const loc = root.locator(f.css);
      return (f.inner ? loc.locator(f.inner) : loc).first();
    }
    return locateField(root, f);
  }

  // Fills a form's fields. valueFor(field) returns a string to type, or
  // undefined to fall back to the crawler's fake test data.
  async fillForm(el, valueFor = () => undefined) {
    for (const f of el.form.fields) {
      const locator = this.field(f);
      const custom = valueFor(f);
      if (custom !== undefined) {
        await locator.fill(custom, { timeout: 5000 });
        continue;
      }
      const plan = testValueFor(f);
      if (plan.kind === "fill") await locator.fill(plan.value, { timeout: 5000 });
      else if (plan.kind === "check") await locator.check({ timeout: 5000 }).catch(() => {});
      else if (plan.kind === "select") {
        if ((await locator.locator("option").count()) > 1) await locator.selectOption({ index: 1 }, { timeout: 5000 });
      }
    }
  }

  // Submits with the form's submit button, or Enter in its first text field.
  async submitForm(el) {
    const form = el.form;
    if (form.submitDomIndex !== null) {
      const submit = await locateClickable(this.root(el), {
        domIndex: form.submitDomIndex,
        role: "button",
        text: form.submitText,
      });
      await submit.click({ timeout: 5000 });
      return;
    }
    const field = form.fields.find(isTextish) || form.fields[0];
    await this.field(field).press("Enter", { timeout: 5000 });
  }

  // Is `text` visible on the page (input values excluded, so text that was
  // typed but never saved doesn't count)?
  hasText(text) {
    return this.page.evaluate((t) => (document.body?.innerText || "").includes(t), text).catch(() => false);
  }

  async visiblePasswordFields() {
    const all = this.page.locator('input[type="password"]');
    let n = 0;
    for (let i = 0; i < (await all.count()); i++) if (await all.nth(i).isVisible().catch(() => false)) n++;
    return n;
  }
}
