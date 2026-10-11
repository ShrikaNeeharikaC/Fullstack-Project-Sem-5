import { check } from "../checks.js";

// Static audit, run in the page: labels, names, contrast, keyboard reach.
function audit() {
  const clean = (v) => (v || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const describe = (el) =>
    `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("name") ? ` name=${el.getAttribute("name")}` : ""}> "${clean(el.innerText || el.getAttribute("placeholder") || "").slice(0, 40)}"`;
  const labelledBy = (el) =>
    (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ");
  const accessibleName = (el) =>
    clean(
      el.getAttribute("aria-label") ||
        labelledBy(el) ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) ||
        el.closest("label")?.innerText ||
        el.getAttribute("title") ||
        (["BUTTON", "A", "SUMMARY"].includes(el.tagName) ? el.innerText || [...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ") : "") ||
        (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) ? el.value : ""),
    );

  const fields = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea')].filter(visible);
  const unlabeled = fields.filter((el) => !accessibleName(el)).map(describe);

  const controls = [...document.querySelectorAll('a[href], button, [role="button"], [role="link"], input[type="submit"], input[type="button"]')].filter(visible);
  const unnamed = controls.filter((el) => !accessibleName(el)).map((el) => `${describe(el)} ${el.getAttribute("href") || ""}`.trim());

  // Mouse-only controls: clickable-looking elements a keyboard can't reach.
  const mouseOnly = [...document.querySelectorAll("div, span, li, img, td, i, svg, p")]
    .filter((el) => visible(el) && !el.closest('a, button, [role], label, input, select, textarea, summary'))
    .filter((el) => el.hasAttribute("onclick") || (getComputedStyle(el).cursor === "pointer" && el.parentElement && getComputedStyle(el.parentElement).cursor !== "pointer"))
    .filter((el) => !el.querySelector("a, button, input") && !el.hasAttribute("tabindex"))
    .slice(0, 10)
    .map(describe);

  // Text contrast (WCAG AA): 4.5:1, or 3:1 for large text.
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const ch = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const background = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null; // can't judge text over images
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lowContrast = [];
  const textEls = [...document.querySelectorAll("p, span, a, button, label, li, td, th, h1, h2, h3, h4, h5, h6, small, strong, em, div")]
    .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1) && visible(el))
    .slice(0, 400);
  for (const el of textEls) {
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = background(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) lowContrast.push(`${describe(el)} ${ratio.toFixed(2)}:1`);
  }

  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(visible);
  return {
    lang: document.documentElement.getAttribute("lang") || "",
    title: document.title.trim(),
    unlabeled,
    unnamed,
    mouseOnly,
    lowContrast,
    hasH1: headings.some((h) => h.tagName === "H1"),
    interactiveCount: controls.length + fields.length,
  };
}

export default {
  id: "accessibility",
  name: "Page is accessible (labels, names, contrast, keyboard)",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page, audit the DOM, then Tab through it with the keyboard",
    expectedNetwork: "n/a",
    expectedStateChange:
      "Every field has a label, every control a name, text meets WCAG AA contrast, focus moves with Tab and is visible",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Add <label>/aria-label to fields and icon buttons, use real <button>/<a> for clickable elements, darken low-contrast text, and keep a visible :focus-visible style.",

  async run(t) {
    await t.fresh();
    // Start keyboard navigation from the top of the document. (No click: a
    // click at the page corner can land on a link and navigate away.)
    const obs = await t.act("Audit the page and tab through it", () =>
      t.page.evaluate(() => {
        document.activeElement?.blur?.();
        window.focus();
      }),
    );
    const a = await t.page.evaluate(audit);

    // Keyboard: Tab up to 30 times; focus must move and be visible.
    const stops = [];
    for (let i = 0; i < 30; i++) {
      await t.page.keyboard.press("Tab");
      const info = await t.page.evaluate(() => {
        // Follow focus into shadow roots; focus inside an iframe belongs to
        // the frame's own document, so it isn't judged from here.
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        if (!el || el === document.body || el.tagName === "IFRAME" || el.shadowRoot) return null;
        const pick = (s) => [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.textDecorationLine].join("|");
        const focused = pick(getComputedStyle(el));
        el.blur();
        const blurred = pick(getComputedStyle(el));
        el.focus();
        const s = getComputedStyle(el);
        const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
        return {
          name: `<${el.tagName.toLowerCase()}> "${(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 30)}"`,
          visibleFocus: outline || focused !== blurred,
        };
      });
      if (!info) continue;
      stops.push(info);
    }
    const distinct = new Set(stops.map((s) => s.name));
    const noFocusStyle = [...new Set(stops.filter((s) => !s.visibleFocus).map((s) => s.name))];
    // Stuck = the same element keeps focus for 5+ Tabs in a row.
    let trap = null;
    for (let i = 4; i < stops.length; i++) {
      if (stops.slice(i - 4, i + 1).every((s) => s.name === stops[i].name)) trap = stops[i].name;
    }
    const list = (arr) => `${arr.length}: ${arr.slice(0, 4).join("; ")}`;

    return {
      primary: obs,
      persistsOnReload: null,
      checks: [
        check("Form fields have labels", a.unlabeled.length === 0, {
          expected: "label, aria-label or aria-labelledby on every field (placeholder alone isn't enough)",
          actual: list(a.unlabeled),
          severity: "medium",
          issue: `${a.unlabeled.length} form field(s) without a label`,
        }),
        check("Buttons and links have accessible names", a.unnamed.length === 0, {
          expected: "text, aria-label or title on every control",
          actual: list(a.unnamed),
          severity: "medium",
          issue: `${a.unnamed.length} button(s)/link(s) with no accessible name`,
        }),
        check("Clickable elements are keyboard-reachable", a.mouseOnly.length === 0, {
          expected: "clickable elements are <button>/<a> or have role + tabindex",
          actual: list(a.mouseOnly),
          severity: "medium",
          issue: `${a.mouseOnly.length} clickable element(s) only work with a mouse`,
        }),
        check("Text has enough contrast", a.lowContrast.length === 0, {
          expected: "WCAG AA: 4.5:1 (3:1 for large text)",
          actual: list(a.lowContrast),
          severity: "low",
          issue: `${a.lowContrast.length} text element(s) fail the WCAG AA contrast check`,
        }),
        check("Tab moves focus through the page", a.interactiveCount === 0 || distinct.size > 1, {
          expected: "focus moves between controls",
          actual: `${distinct.size} distinct focus stops in 30 Tabs`,
          severity: "medium",
          issue: "Keyboard Tab does not move focus through the page",
        }),
        check("No keyboard trap", !trap, {
          expected: "Tab always leaves an element",
          actual: trap ? `focus stuck on ${trap}` : "none",
          severity: "medium",
          issue: `Keyboard focus gets stuck on ${trap}`,
        }),
        check("Focus is visible", noFocusStyle.length === 0, {
          expected: "outline or style change on focus",
          actual: list(noFocusStyle),
          severity: "low",
          issue: `${noFocusStyle.length} control(s) show no visible focus indicator`,
        }),
        check("Page declares a language", !!a.lang, {
          expected: '<html lang="...">',
          actual: a.lang || "missing",
          severity: "low",
          issue: "Page has no lang attribute",
        }),
        check("Page has a title", !!a.title, {
          expected: "non-empty <title>",
          actual: a.title || "empty",
          severity: "low",
          issue: "Page has no title",
        }),
        check("Page has an h1", a.hasH1, {
          expected: "one main heading",
          actual: a.hasH1 ? "present" : "missing",
          severity: "low",
          soft: true,
        }),
      ],
    };
  },
};
