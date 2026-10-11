import { check } from "../checks.js";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

// Layout problems visible at the current viewport size.
function layoutAudit(mobile) {
  const clean = (v) => (v || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const name = (el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : ""}> "${clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt"))}"`;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 1. Sideways scrolling, and the widest culprits (ignoring content inside
  //    containers that clip or scroll on purpose).
  const clipped = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") return true;
    }
    return false;
  };
  const overflowPx = document.documentElement.scrollWidth - vw;
  const tooWide = overflowPx > 2
    ? [...document.body.querySelectorAll("*")]
        .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 2 && !clipped(el))
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
        .slice(0, 3)
        .map((el) => `${name(el)} reaches ${Math.round(el.getBoundingClientRect().right)}px`)
    : [];

  // 2. Controls covered by something else (the "navbar overlaps the hero" bug).
  //    A full-screen fixed overlay (cookie wall, modal) is reported, not each control.
  const controls = [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]')].filter((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
  });
  const covered = [];
  let overlay = null;
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el) || hit.closest("label")?.contains(el)) continue;
    let top = hit;
    while (top.parentElement && top.parentElement !== document.body && !["fixed", "sticky"].includes(getComputedStyle(top).position)) top = top.parentElement;
    const tr = top.getBoundingClientRect();
    if (["fixed", "sticky"].includes(getComputedStyle(top).position) && tr.width * tr.height > 0.5 * vw * vh) {
      overlay = name(top);
      break;
    }
    covered.push(`${name(el)} covered by ${name(hit)}`);
  }

  // 3. Text boxes overlapping each other (neither inside the other).
  //    Inline boxes are skipped: a wrapped inline element's bounding box spans
  //    whole lines and "overlaps" its neighbours without anything being wrong.
  const texts = [...document.querySelectorAll("h1, h2, h3, h4, p, button, a, li")]
    .filter((el) => visible(el) && clean(el.innerText) && getComputedStyle(el).display !== "inline")
    .slice(0, 200);
  const overlaps = [];
  for (let i = 0; i < texts.length && overlaps.length < 5; i++) {
    for (let j = i + 1; j < texts.length && overlaps.length < 5; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      if (w * h > 0.3 * Math.min(ra.width * ra.height, rb.width * rb.height)) overlaps.push(`${name(a)} overlaps ${name(b)}`);
    }
  }

  // 4. Touch targets and tiny text (mobile only). WCAG 2.2 minimum is 24px,
  //    unless the target has room around it (spacing exception): only small
  //    targets with another control within 8px are flagged.
  const near = (a, b, gap) => {
    const r = a.getBoundingClientRect();
    const s = b.getBoundingClientRect();
    return r.left - gap < s.right && s.left < r.right + gap && r.top - gap < s.bottom && s.top < r.bottom + gap;
  };
  const smallTargets = mobile
    ? controls
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!(r.width < 24 || r.height < 24) || el.closest("p, li") || el.tagName === "INPUT") return false;
          return controls.some((o) => o !== el && !o.contains(el) && !el.contains(o) && near(el, o, 8));
        })
        .slice(0, 5)
        .map((el) => `${name(el)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
    : [];
  const tinyText = mobile
    ? [...document.querySelectorAll("p, span, a, li, td, label")].filter((el) => visible(el) && clean(el.innerText) && parseFloat(getComputedStyle(el).fontSize) < 12).length
    : 0;

  return { overflowPx: Math.max(0, overflowPx), tooWide, covered: covered.slice(0, 5), overlay, overlaps, smallTargets, tinyText };
}

export default {
  id: "responsive-layout",
  name: "Layout works on mobile, tablet and desktop",
  scope: "page",
  categories: ["generic"],
  requires: [],
  severity: "medium",
  spec: {
    action: "Load the page at 390×844 (mobile), 768×1024 (tablet) and 1440×900 (desktop)",
    expectedNetwork: "n/a",
    expectedStateChange: "No sideways scrolling, no control covered by another element, no overlapping text, tap targets ≥ 24px on mobile",
    persistsOnReload: "n/a",
  },
  fixHint:
    "Add the missing breakpoint rules: let wide elements shrink (max-width: 100%), fix the z-index/margins of the element covering others, and give small controls at least 24×24px of tap area.",

  async run(t) {
    const checks = [];
    let primary = null;
    try {
      for (const vp of VIEWPORTS) {
        await t.page.setViewportSize({ width: vp.width, height: vp.height });
        const obs = await t.act(`Load at ${vp.name} size ${vp.width}×${vp.height}`, () =>
          t.page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 }),
        );
        primary = primary || obs;
        const a = await t.page.evaluate(layoutAudit, vp.name === "mobile");
        const at = `on ${vp.name} (${vp.width}px)`;

        if (vp.name !== "desktop") {
          checks.push(
            check(`No sideways scrolling ${at}`, a.overflowPx <= 2, {
              expected: "page fits the screen width",
              actual: a.overflowPx > 2 ? `${a.overflowPx}px too wide: ${a.tooWide.join("; ")}` : "fits",
              severity: vp.name === "mobile" ? "medium" : "low",
              issue: `Page scrolls sideways ${at}`,
            }),
          );
        }
        checks.push(
          check(`No control is covered by another element ${at}`, a.covered.length === 0, {
            expected: "every visible control is clickable at its centre",
            actual: a.covered.join("; ") || "none",
            severity: "medium",
            issue: `${a.covered.length} control(s) covered by other elements ${at}`,
          }),
          check(`No overlapping text ${at}`, a.overlaps.length === 0, {
            expected: "text boxes don't overlap",
            actual: a.overlaps.join("; ") || "none",
            severity: "low",
            issue: `Overlapping text ${at}`,
          }),
          check(`No full-screen overlay blocking the page ${at}`, !a.overlay, {
            expected: "page usable after load",
            actual: a.overlay || "none",
            severity: "low",
            soft: true,
          }),
        );
        if (vp.name === "mobile") {
          checks.push(
            check("Tap targets are at least 24px on mobile", a.smallTargets.length === 0, {
              expected: "≥ 24×24px",
              actual: a.smallTargets.join("; ") || "all large enough",
              severity: "low",
              issue: `${a.smallTargets.length} tap target(s) smaller than 24px on mobile`,
            }),
            check("Text is readable on mobile (≥ 12px)", a.tinyText === 0, {
              expected: "no text under 12px",
              actual: `${a.tinyText} element(s) under 12px`,
              severity: "low",
              soft: true,
            }),
          );
        }
      }
    } finally {
      await t.page.setViewportSize(DEFAULT_VIEWPORT);
    }
    return { primary, persistsOnReload: null, checks };
  },
};
